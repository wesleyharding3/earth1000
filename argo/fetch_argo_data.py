import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATA_URL


def fetch_data():

    print("Downloading test dataset...")

    df = pd.read_csv(DATA_URL)

    print(f"Rows downloaded: {len(df)}")

    return df


def insert_data(df):

    engine = create_engine(DATABASE_URL)

    print("Inserting into database...")

    df.to_sql(
        "test_ingestion",
        engine,
        schema="ocean",
        if_exists="append",
        index=False
    )

    print("Insert complete")


def main():

    df = fetch_data()

    insert_data(df)


if __name__ == "__main__":
    main()