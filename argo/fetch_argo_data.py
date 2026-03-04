import copernicusmarine
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATASET_ID, VARIABLE


def fetch_ocean_data():

    print("Downloading Copernicus ocean temperature...")

    ds = copernicusmarine.open_dataset(
        dataset_id=DATASET_ID
    )

    df = ds[VARIABLE].to_dataframe().reset_index()

    df = df.rename(columns={
        "latitude": "latitude",
        "longitude": "longitude",
        VARIABLE: "temperature"
    })

    df = df.dropna()

    print(f"Rows downloaded: {len(df)}")

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