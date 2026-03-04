import pandas as pd
import requests
import time
from sqlalchemy import create_engine
from config import DATABASE_URL, DATA_URL


def fetch_ocean_data():

    print("Downloading ocean dataset...")

    retries = 5
    delay = 10

    for attempt in range(retries):
        try:
            response = requests.get(DATA_URL, timeout=60)

            if response.status_code == 200:
                break

            print(f"Server returned {response.status_code}, retrying...")
            time.sleep(delay)

        except Exception as e:
            print("Request failed:", e)
            time.sleep(delay)

    else:
        raise Exception("Failed to download dataset after retries")

    df = pd.read_csv(pd.compat.StringIO(response.text))

    df = df.rename(columns={
        "latitude": "latitude",
        "longitude": "longitude",
        "sst": "temperature"
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