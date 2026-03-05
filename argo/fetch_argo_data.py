import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATA_URL


def fetch_ocean_data():
    print("Downloading SST dataset from NOAA ERDDAP...")

    # ERDDAP CSVs have a units row on line 2 — skip it with header + skiprows
    df = pd.read_csv(DATA_URL, header=0, skiprows=[1])

    # Normalize column names regardless of source casing
    df.columns = [c.strip().lower() for c in df.columns]

    # ERDDAP returns: time, latitude, longitude, sst
    df = df.rename(columns={"sst": "temperature"})

    # Keep only the columns we need
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