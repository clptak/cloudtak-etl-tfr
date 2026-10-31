# CloudTAK ETL TFR

CloudTAK ETL that polls the [FAA TFR list](https://tfr.faa.gov) and posts every
Temporary Flight Restriction area as a red TAK polygon (`u-d-f`).

Replaces the Node-RED `tfr2cot` + `cot-reconciler` flow - no PostGIS table is needed.

## How it works

1. `GET https://tfr.faa.gov/tfrapi/exportTfrList`
2. Keep the TFRs filed under the selected `States` (all of them when none are selected)
3. Fetch each `detail_<id>.xml` (8 at a time) and turn every `TFRAreaGroup` with a
   merged boundary into one polygon, with the altitude band, effective/expire times,
   and the FAA NOTAM text in the remarks plus a link to the FAA detail page
4. Submit the FeatureCollection to the Layer

Each polygon's `stale` is `now + StaleMinutes`, capped at the TFR's expiry. Because the
Layer refreshes every TFR on each run, a TFR that drops off the FAA list ages off
the map within `StaleMinutes`, so the ETL does not need to track state.

TFRs with no published boundary (the national security notices, the DC SFRA, and the
Mexico border TFRs) are skipped. Expired TFRs are dropped.

## Environment

| Name           | Default | Description |
| -------------- | ------- | ----------- |
| `States`       | `[]`    | 2-letter codes (states, DC, PR, VI, GU, AS, MP). Empty = nationwide |
| `StaleMinutes` | `45`    | Keep at 2-3x the schedule interval |
| `DEBUG`        | `false` | Log per-TFR area counts and the submitted features |

To send the TFRs to a channel such as `ps_aircraft`, set it on the Layer's Connection
in CloudTAK. The ETL itself only submits features.

## Development

```sh
npm install
npm run lint
npm test
```

## Deploy

```sh
export AWS_REGION='us-east-1'
export AWS_ACCOUNT_ID='123456789012'
npx cloudtak-etl
```
