import pandas as pd
from sqlalchemy import create_engine

DATABASE_URL = "postgresql://earth10000_user:AWiupOE9c3xO9etCCgN7Rbw6CcAh6Bkl@dpg-d69v586sb7us73d2hvng-a.oregon-postgres.render.com/earth10000"

engine = create_engine(DATABASE_URL)

ERDDAP_URL = (
"https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.csv?"
"platform_number,time,latitude,longitude,pressure,temperature,salinity"
"&time>=now-3days"
)

print("Downloading ARGO data...")

df = pd.read_csv(ERDDAP_URL)

df = df.rename(columns={
    "platform_number": "float_id",
    "pressure": "depth"
})

df.to_sql(
    "argo_measurements",
    engine,
    schema="ocean",
    if_exists="append",
    index=False,
    method="multi"
)

print("Finished inserting data")