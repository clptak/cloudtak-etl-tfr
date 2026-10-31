import { Type, TSchema, Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType } from '@tak-ps/etl';
import { FAA, STATES, filterList, detailUrl, toFeatures, mapLimit } from './lib/tfr.js';
import type { ListItem } from './lib/tfr.js';

const Env = Type.Object({
    States: Type.Array(Type.String({ enum: STATES }), {
        default: [],
        description: 'Only post TFRs filed under these states - leave empty for every state'
    }),
    StaleMinutes: Type.Integer({
        default: 45,
        minimum: 5,
        description: 'Minutes a TFR stays on the map without a refresh - keep it above the schedule interval (2-3x) so a removed TFR ages out and a single failed poll does not blank the map'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print ETL specific debug information'
    })
});

/** Metadata attached to every posted TFR area */
const Output = Type.Object({
    notam_id: Type.String(),
    state: Type.String(),
    facility: Type.String(),
    tfr_type: Type.String(),
    area: Type.Optional(Type.String()),
    lower: Type.String(),
    upper: Type.String(),
    effective: Type.Optional(Type.String()),
    expire: Type.Optional(Type.String())
});

/** Detail documents fetched at once - the FAA site is slow but tolerates a few parallel requests */
const CONCURRENCY = 8;
const TIMEOUT = 20 * 1000;

export default class Task extends ETL {
    static name = 'cloudtak-etl-tfr';
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            return type === SchemaType.Input ? Env : Output;
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env: Static<typeof Env> = await this.env(Env);

        const list = await this.list();
        const items = filterList(list, env.States ?? []);
        console.log(`ok - ${items.length} of ${list.length} TFRs match ${env.States?.length ? env.States.join(',') : 'all states'}`);

        const now = new Date();
        const staleMs = (env.StaleMinutes ?? 45) * 60 * 1000;

        const results = await mapLimit(items, CONCURRENCY, async (item) => {
            try {
                const features = toFeatures(item, await this.detail(item), { staleMs, now });
                if (env.DEBUG) console.log(`ok - ${item.notam_id} (${item.state}): ${features.length} areas`);
                return features;
            } catch (err) {
                console.error(`not ok - ${item.notam_id} (${item.state}):`, err instanceof Error ? err.message : err);
                return [];
            }
        });

        const features: Static<typeof Feature.InputFeature>[] = results.flat();
        console.log(`ok - posting ${features.length} TFR areas`);

        await this.submit({
            type: 'FeatureCollection',
            features
        }, {
            verbose: env.DEBUG
        });
    }

    async list(): Promise<ListItem[]> {
        const res = await fetch(`${FAA}/tfrapi/exportTfrList`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!res.ok) throw new Error(`FAA TFR list returned ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body)) throw new Error('FAA TFR list is not an array');
        return body as ListItem[];
    }

    async detail(item: ListItem): Promise<string> {
        const res = await fetch(detailUrl(item.notam_id), {
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!res.ok) throw new Error(`detail returned ${res.status}`);
        return await res.text();
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
