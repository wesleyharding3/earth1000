import pandas as pd
import requests
from sqlalchemy import create_engine
from config import DATABASE_URL, ARGO_URL
from io import StringIO


def fetch_argo_data():
    print("Downloading ARGO data...")

    response = requests.get(ARGO_URL, timeout=60)

    if response.status_code != 200:
        raise Exception(f"Failed to download data: {response.status_code}")

    csv_data = StringIO(response.text)

    df = pd.read_csv(csv_data)

    df = df.rename(columns={
        "platform_number": "float_id",
        "pressure": "depth"
    })

    print(f"Rows downloaded: {len(df)}")

    return df


def insert_data(df):
    engine = create_engine(DATABASE_URL)

    print("Inserting data into database...")

    df.to_sql(
        "argo_measurements",
        engine,
        schema="ocean",
        if_exists="append",
        index=False,
        method="multi",
        chunksize=1000
    )

    print("Finished inserting data")


def main():
    df = fetch_argo_data()
    insert_data(df)


if __name__ == "__main__":
    main()