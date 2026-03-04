import copernicusmarine
import xarray as xr
import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, DATASET_ID, VARIABLE


engine = create_engine(DATABASE_URL)


def process_tile(lat_min, lat_max):

    print(f"Downloading tile {lat_min} → {lat_max}")

    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=[VARIABLE],
        minimum_longitude=-180,
        maximum_longitude=180,
        minimum_latitude=lat_min,
        maximum_latitude=lat_max,
        start_datetime="2024-01-01T00:00:00",
        end_datetime="2024-01-01T00:00:00",
        output_filename="tile.nc"
    )

    ds = xr.open_dataset("tile.nc")

    surface = ds[VARIABLE].isel(depth=0)

    df = surface.to_dataframe().reset_index()

    # downsample grid
    df["latitude"] = df["latitude"].round()
    df["longitude"] = df["longitude"].round()

    df = df.groupby(["latitude", "longitude"])[VARIABLE].mean().reset_index()

    df = df.rename(columns={VARIABLE: "temperature"})

    df.to_sql(
        "ocean_temperature",
        engine,
        schema="ocean",
        if_exists="append",
        index=False,
        method="multi",
        chunksize=2000
    )

    print(f"Inserted {len(df)} rows")


def main():

    for lat in range(-80, 90, 10):   # 10° latitude bands
        process_tile(lat, lat + 10)


if __name__ == "__main__":
    main()