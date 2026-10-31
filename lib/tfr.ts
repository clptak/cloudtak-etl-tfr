import { XMLParser } from 'fast-xml-parser';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';

export const FAA = 'https://tfr.faa.gov';

/** States, DC & territories the FAA files TFRs under - USA is used for nationwide, shapeless notices */
export const STATES = [
    'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD',
    'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH',
    'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
    'DC', 'PR', 'VI', 'GU', 'AS', 'MP'
];

/** An entry of the FAA exportTfrList response */
export interface ListItem {
    notam_id: string;
    type: string;
    facility: string;
    state: string;
    description: string;
    creation_date: string;
}

/** Offsets in hours of the time zones the FAA writes in codeTimeZone */
const ZONES: Record<string, number> = {
    UTC: 0, GMT: 0, Z: 0,
    EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
    AKST: -9, AKDT: -8, HST: -10, AST: -4, SST: -11, CHST: 10
};

const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ['Group', 'Add', 'Not', 'TFRAreaGroup', 'Avx', 'txtInstr'].includes(name)
});

/** Only the parts of the XNOTAM document this ETL reads */
interface Avx { geoLat: string; geoLong: string }
interface AreaGroup {
    aseTFRArea?: {
        txtName?: string;
        codeDistVerUpper?: string; valDistVerUpper?: string; uomDistVerUpper?: string;
        codeDistVerLower?: string; valDistVerLower?: string; uomDistVerLower?: string;
    };
    abdMergedArea?: { Avx?: Avx[] };
}
interface Notam {
    NotUid: { codeGUID: string; noSeqNo: string; dateIndexYear: string };
    dateEffective?: string;
    dateExpire?: string;
    codeTimeZone?: string;
    codeExpirationTimeZone?: string;
    txtDescrPurpose?: string;
    txtDescrTraditional?: string;
    TfrNot?: { TFRAreaGroup?: AreaGroup[] };
}

/** Keep the entries filed under one of the states, every entry when no states are given */
export function filterList(list: ListItem[], states: string[]): ListItem[] {
    if (!states.length) return list;
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    return list.filter((item) => wanted.has(item.state));
}

/** 6/2204 -> https://tfr.faa.gov/download/detail_6_2204.xml */
export function detailUrl(notamId: string, format: 'xml' | 'html' = 'xml'): string {
    const id = notamId.replace(/\//g, '_');
    return format === 'xml'
        ? `${FAA}/download/detail_${id}.xml`
        : `${FAA}/tfr3/?page=detail_${id}`;
}

/** 33.55282419N -> 33.55282419, 144.8447E -> 144.8447, 112.26W -> -112.26 */
export function coordinate(value: string): number {
    const hemi = value.slice(-1).toUpperCase();
    const num = parseFloat(['N', 'S', 'E', 'W'].includes(hemi) ? value.slice(0, -1) : value);
    return hemi === 'S' || hemi === 'W' ? -num : num;
}

/** A FAA local timestamp in a named zone to a Date - undefined when the zone is unknown */
export function faaDate(value: string | undefined, zone: string | undefined): Date | undefined {
    if (!value) return;
    const offset = ZONES[(zone || 'UTC').toUpperCase()];
    if (offset === undefined) return;
    const date = new Date(`${value}Z`);
    if (isNaN(date.getTime())) return;
    return new Date(date.getTime() - offset * 3600 * 1000);
}

/** One vertical limit: SFC, 400 FT AGL, 18000 FT MSL, FL430 */
export function altitude(code?: string, value?: string, uom?: string): string {
    if (value === undefined || value === '') return 'UNK';
    if (uom === 'FL') return `FL${value.padStart(3, '0')}`;
    if (code === 'HEI' && Number(value) === 0) return 'SFC';
    return `${value} ${uom || 'FT'} ${code === 'HEI' ? 'AGL' : 'MSL'}`;
}

export function parseDetail(xml: string): Notam {
    const doc = parser.parse(xml.replace(/^\uFEFF/, ''));
    const notam = doc?.['XNOTAM-Update']?.Group?.[0]?.Add?.[0]?.Not?.[0];
    if (!notam?.NotUid?.codeGUID) throw new Error('XNOTAM document has no NotUid');
    return notam as Notam;
}

export interface FeatureOptions {
    /** How long a posted area stays on the map without being refreshed */
    staleMs: number;
    now?: Date;
}

/**
 * Turn the XNOTAM document of a list entry into one polygon per TFR area
 *
 * Areas without a merged boundary (border, nationwide & DC SFRA notices) are skipped,
 * as is the whole TFR once it has expired
 */
export function toFeatures(item: ListItem, xml: string, opts: FeatureOptions): Static<typeof Feature.InputFeature>[] {
    const now = opts.now ?? new Date();
    const notam = parseDetail(xml);

    const expire = faaDate(notam.dateExpire, notam.codeExpirationTimeZone ?? notam.codeTimeZone);
    if (expire && expire <= now) return [];

    const effective = faaDate(notam.dateEffective, notam.codeTimeZone);

    // Never outlive the TFR itself
    let stale = new Date(now.getTime() + opts.staleMs);
    if (expire && expire < stale) stale = expire;

    const groups = notam.TfrNot?.TFRAreaGroup ?? [];
    const features: Static<typeof Feature.InputFeature>[] = [];

    groups.forEach((group, i) => {
        const avx = group.abdMergedArea?.Avx ?? [];
        if (avx.length < 3) return;

        const ring = avx.map((v) => [coordinate(v.geoLong), coordinate(v.geoLat)]);
        if (ring.some((c) => c.some(isNaN))) return;

        const [fx, fy] = ring[0];
        const [lx, ly] = ring[ring.length - 1];
        if (fx !== lx || fy !== ly) ring.push([fx, fy]);

        const area = group.aseTFRArea ?? {};
        const name = groups.length > 1 ? (area.txtName || `Area ${i + 1}`) : '';
        const lower = altitude(area.codeDistVerLower, area.valDistVerLower, area.uomDistVerLower);
        const upper = altitude(area.codeDistVerUpper, area.valDistVerUpper, area.uomDistVerUpper);

        const header = [
            `${item.type} TFR ${item.notam_id}${name ? ` - ${name}` : ''}`,
            item.description,
            `Altitude: ${lower} to ${upper}`,
            effective ? `Effective: ${effective.toISOString()}` : '',
            expire ? `Expires: ${expire.toISOString()}` : 'Expires: Until further notice'
        ].filter(Boolean).join('\n');
        const body = notam.txtDescrTraditional || notam.txtDescrPurpose || '';
        const remarks = body ? `${header}\n\n${body}` : header;

        features.push({
            id: `tfr-${notam.NotUid.codeGUID}-${i}`,
            type: 'Feature',
            properties: {
                type: 'u-d-f',
                how: 'h-e',
                callsign: `TFR ${item.notam_id}${name ? ` ${name}` : ''}`,
                time: now.toISOString(),
                start: now.toISOString(),
                stale: stale.toISOString(),
                stroke: '#FF0000',
                'stroke-opacity': 1,
                'stroke-width': 2,
                fill: '#FF0000',
                'fill-opacity': 0.1,
                labels: true,
                remarks,
                links: [{
                    relation: 'r-u',
                    mime: 'text/html',
                    url: detailUrl(item.notam_id, 'html'),
                    remarks: `FAA TFR ${item.notam_id}`
                }],
                metadata: {
                    notam_id: item.notam_id,
                    state: item.state,
                    facility: item.facility,
                    tfr_type: item.type,
                    area: name || undefined,
                    lower,
                    upper,
                    effective: effective?.toISOString(),
                    expire: expire?.toISOString()
                }
            },
            geometry: {
                type: 'Polygon',
                coordinates: [ring]
            }
        });
    });

    return features;
}

/** Run fn over items with at most `limit` in flight */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}
