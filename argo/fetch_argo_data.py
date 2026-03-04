import requests
import xarray as xr
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, SST_URL


def download_file():

    print("Downloading NOAA SST dataset...")

    r = requests.get(SST_URL, stream=True)

    if r.status_code != 200:
        raise Exception(f"Download failed: {r.status_code}")

    with open("sst.nc", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)

    print("Download complete")


def load_sst():

    print("Opening NetCDF dataset...")

    ds = xr.open_dataset("sst.nc")

    df = ds["sst"].to_dataframe().reset_index()

    df = df.rename(columns={
        "lat": "latitude",
        "lon": "longitude",
        "sst": "temperature"
    })

    df = df.dropna()

    print(f"Rows extracted: {len(df)}")

    return df


def insert_data(df):

    engine = create_engine(DATABASE_URL)

    print("Inserting into database...")

    df.to_sql(
        "ocean_temperature",
        engine,
        schema="ocean",
        if_exists="append",
        index=False,
        method="multi",
        chunksize=2000
    )

    print("Insert complete")


def main():

    download_file()

    df = load_sst()

    insert_data(df)


if __name__ == "__main__":
    main()