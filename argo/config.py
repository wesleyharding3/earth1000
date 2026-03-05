import os

DATABASE_URL = os.getenv("DATABASE_URL")

DATA_URL = (
    "https://coastwatch.pfeg.noaa.gov/erddap/griddap/nceiErsstv5.csv"
    "?sst[(2020-01-15T00:00:00Z):1:(2023-01-15T00:00:00Z)]"
    "[(88.0):10:(-88.0)][(0.0):10:(358.0)]"
)