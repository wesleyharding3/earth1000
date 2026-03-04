import pandas as pd
from sqlalchemy import create_engine
from config import DATABASE_URL, ARGO_URL

engine = create_engine(DATABASE_URL)

print("Downloading ARGO data...")

df = pd.read_csv(ARGO_URL)

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