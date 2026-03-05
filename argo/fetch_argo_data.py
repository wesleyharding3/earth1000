import io
import requests
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATA_URL


def fetch_ocean_data():
    print(f"Downloading SST dataset from:\n{DATA_URL}")

    response = requests.get(DATA_URL, timeout=120)

    if response.status_code != 200:
        raise RuntimeError(
            f"HTTP {response.status_code}\n{response.text[:500]}"
        )

    df = pd.read_csv(io.StringIO(response.text), skiprows=[1])
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={"sst": "temperature"})
    df = df[["time", "latitude", "longitude", "temperature"]]
    df = df.dropna(subset=["temperature"])

    print(f"Rows downloaded: {len(df)}")
    return df


def insert_data(df):
    engine = create_engine(DATABASE_URL)
    print("Inserting ocean temperature data...")
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