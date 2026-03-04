import os

DATABASE_URL = os.getenv("DATABASE_URL")

DATA_URL = (
"https://coastwatch.pfeg.noaa.gov/erddap/griddap/"
"ncdcOisst21Agg_LonPM180.csv?"
"sst[(2024-01-01T00:00:00Z)][(-89):1:(89)][(-179):1:(179)]"
)