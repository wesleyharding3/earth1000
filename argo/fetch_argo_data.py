import requests
import pandas as pd
import xarray as xr
from sqlalchemy import create_engine
from config import DATABASE_URL, SST_URL


def fetch_sst():

    print("Downloading NOAA sea surface temperature dataset...")

    ds = xr.open_dataset(SST_URL)

    df = ds["sst"].to_dataframe().reset_index()

    df = df.rename(columns={
        "lat": "latitude",
        "lon": "longitude",
        "sst": "temperature"
    })

    df = df.dropna()

    print(f"Rows downloaded: {len(df)}")

    return df


def insert_data(df):

    engine = create_engine(DATABASE_URL)

    print("Inserting SST data...")

    df.to_sql(
        "ocean_temperature",
        engine,
        schema="ocean",
        if_exists="append",
        index=False,
        method="multi",
        chunksize=2000
    )

    print("Finished inserting data")


def main():

    df = fetch_sst()

    insert_data(df)


if __name__ == "__main__":
    main()