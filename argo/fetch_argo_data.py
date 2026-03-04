import copernicusmarine
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATASET_ID, VARIABLE


def fetch_ocean_data():

    print("Downloading Copernicus ocean temperature dataset...")

    ds = copernicusmarine.open_dataset(
        dataset_id=DATASET_ID,
        minimum_longitude=-180,
        maximum_longitude=180,
        minimum_latitude=-90,
        maximum_latitude=90
    )

    df = ds[VARIABLE].to_dataframe().reset_index()

    # Downsample to ~1° grid
    df["latitude"] = df["latitude"].round()
    df["longitude"] = df["longitude"].round()

    df = df.groupby(["latitude", "longitude"])[VARIABLE].mean().reset_index()

    df = df.rename(columns={
        VARIABLE: "temperature"
    })

    df = df.dropna()

    print(f"Rows after downsampling: {len(df)}")

    return df


def insert_data(df):

    engine = create_engine(DATABASE_URL)

    print("Inserting ocean temperature grid...")

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

    df = fetch_ocean_data()

    insert_data(df)


if __name__ == "__main__":
    main()