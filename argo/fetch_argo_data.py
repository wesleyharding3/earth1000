import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, COPERNICUS_URL


def fetch_ocean_data():

    print("Downloading Copernicus ocean dataset...")

    df = pd.read_csv(COPERNICUS_URL)

    df = df.rename(columns={
        "latitude": "latitude",
        "longitude": "longitude",
        "thetao": "temperature"
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