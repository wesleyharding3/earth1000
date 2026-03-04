import os

DATABASE_URL = os.getenv("DATABASE_URL")

SST_URL = (
"https://coastwatch.pfeg.noaa.gov/erddap/griddap/"
"ncdcOisst21Agg_LonPM180.csv?"
"sst[(2024-01-01T00:00:00Z)]"
"[( -89.875):1:(89.875)]"
"[( -179.875):1:(179.875)]"
)