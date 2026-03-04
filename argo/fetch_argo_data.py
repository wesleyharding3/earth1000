import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATA_URL


def fetch_ocean_data():

    print("Downloading NOAA SST dataset...")

    # pandas >=2 uses regex separator instead of delim_whitespace
    df = pd.read_csv(DATA_URL, sep=r"\s+")

    # normalize column names
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

    print("Inserting ocean temperature grid...")

    df.to_sql(
        "ocean_temperature",
        engine,
        schema="ocean",
        if_exists="replace",
        index=False,
        method="multi",
        chunksize=1000
    )

    print("Insert complete")


def main():

    df = fetch_ocean_data()

    insert_data(df)


if __name__ == "__main__":
    main()