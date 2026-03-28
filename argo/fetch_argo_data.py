import io
import time
import requests
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL

# ERDDAP base — depth is required: [time][depth][lat][lon]
ERDDAP_BASE = (
    "https://coastwatch.pfeg.noaa.gov/erddap/griddap/nceiErsstv5.csv"
    "?sst[({start}T00:00:00Z):1:({end}T00:00:00Z)]"
    "[(0.0):1:(0.0)]"
    "[(-88.0):10:(88.0)]"
    "[(0.0):10:(358.0)]"
)

# Fetch one year-chunk at a time to avoid server-side timeouts
YEAR_CHUNKS = [
    ("2020-01-15", "2020-12-15"),
    ("2021-01-15", "2021-12-15"),
    ("2022-01-15", "2022-12-15"),
    ("2023-01-15", "2023-01-15"),
]

CONNECT_TIMEOUT = 30   # seconds to establish connection
READ_TIMEOUT    = 180  # seconds to receive first byte
MAX_RETRIES     = 3
RETRY_BACKOFF   = 10   # seconds between retries


def _fetch_chunk(start: str, end: str) -> pd.DataFrame:
    url = ERDDAP_BASE.format(start=start, end=end)
    print(f"  → {start} to {end}")
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # stream=True: prevents idle read-timeout while server builds response
            with requests.get(url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), stream=True) as resp:
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                raw = resp.content  # read full streamed body
            df = pd.read_csv(io.BytesIO(raw), skiprows=[1])
            df.columns = [c.strip().lower() for c in df.columns]
            df = df.rename(columns={"sst": "temperature"})
            df = df[["time", "latitude", "longitude", "temperature"]]
            df = df.dropna(subset=["temperature"])
            print(f"     {len(df)} rows")
            return df
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
            if attempt == MAX_RETRIES:
                raise
            wait = RETRY_BACKOFF * attempt
            print(f"     attempt {attempt} failed ({exc.__class__.__name__}), retrying in {wait}s…")
            time.sleep(wait)


def fetch_ocean_data() -> pd.DataFrame:
    print("Downloading SST dataset in yearly chunks…")
    frames = []
    for start, end in YEAR_CHUNKS:
        frames.append(_fetch_chunk(start, end))
    df = pd.concat(frames, ignore_index=True)
    print(f"Total rows: {len(df)}")
    return df


def insert_data(df: pd.DataFrame) -> None:
    engine = create_engine(DATABASE_URL)
    print("Inserting ocean temperature data…")
    df.to_sql(
        "ocean_temperature",
        engine,
        schema="ocean",
        if_exists="replace",
        index=False,
        method="multi",
        chunksize=2000,
    )
    print("Insert complete")


def main():
    df = fetch_ocean_data()
    insert_data(df)


if __name__ == "__main__":
    main()
