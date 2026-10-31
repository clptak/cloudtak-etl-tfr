import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { filterList, detailUrl, coordinate, faaDate, altitude, toFeatures, mapLimit } from '../lib/tfr.js';
import type { ListItem } from '../lib/tfr.js';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const list: ListItem[] = JSON.parse(fixture('list.json'));
const item = (id: string) => list.find((i) => i.notam_id === id)!;

// Fixtures were captured 2026-10-31
const NOW = new Date('2026-10-31T16:00:00Z');
const STALE = 45 * 60 * 1000;

test('filterList - empty states keeps every TFR', () => {
    assert.equal(filterList(list, []).length, list.length);
});

test('filterList - selected states only', () => {
    const az = filterList(list, ['AZ']);
    assert.equal(az.length, 3);
    assert.ok(az.every((i) => i.state === 'AZ'));
    assert.equal(filterList(list, ['az', 'GU']).length, 5);
});

test('detailUrl', () => {
    assert.equal(detailUrl('6/2204'), 'https://tfr.faa.gov/download/detail_6_2204.xml');
    assert.equal(detailUrl('6/2204', 'html'), 'https://tfr.faa.gov/tfr3/?page=detail_6_2204');
});

test('coordinate - hemispheres', () => {
    assert.equal(coordinate('33.5N'), 33.5);
    assert.equal(coordinate('33.5S'), -33.5);
    assert.equal(coordinate('112.25W'), -112.25);
    assert.equal(coordinate('144.8E'), 144.8);
});

test('faaDate - zones', () => {
    assert.equal(faaDate('2026-11-01T18:00:00', 'UTC')?.toISOString(), '2026-11-01T18:00:00.000Z');
    assert.equal(faaDate('2026-11-01T18:00:00', 'MST')?.toISOString(), '2026-11-02T01:00:00.000Z');
    assert.equal(faaDate('2026-11-01T18:00:00', 'NOPE'), undefined);
    assert.equal(faaDate(undefined, 'UTC'), undefined);
});

test('altitude', () => {
    assert.equal(altitude('HEI', '0', 'FT'), 'SFC');
    assert.equal(altitude('HEI', '400', 'FT'), '400 FT AGL');
    assert.equal(altitude('ALT', '18000', 'FT'), '18000 FT MSL');
    assert.equal(altitude('ALT', '430', 'FL'), 'FL430');
});

test('toFeatures - single area Arizona TFR', () => {
    const features = toFeatures(item('6/2204'), fixture('6_2204.xml'), { staleMs: STALE, now: NOW });
    assert.equal(features.length, 1);

    const f = features[0];
    assert.equal(f.id, 'tfr-f09aa326-52f2-4a34-a255-018caa66e5c5-0');
    assert.equal(f.properties.type, 'u-d-f');
    assert.equal(f.properties.callsign, 'TFR 6/2204');
    assert.equal(f.properties.stale, new Date(NOW.getTime() + STALE).toISOString());
    assert.match(f.properties.remarks!, /Altitude: SFC to 400 FT AGL/);
    assert.match(f.properties.remarks!, /!FDC 6\/2204/);
    assert.equal(f.properties.links![0].url, 'https://tfr.faa.gov/tfr3/?page=detail_6_2204');

    assert.equal(f.geometry.type, 'Polygon');
    const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(ring.every(([lon, lat]) => lon < -112 && lon > -113 && lat > 33 && lat < 34));
});

test('toFeatures - multi area TFR names each area', () => {
    const features = toFeatures(item('6/2481'), fixture('6_2481.xml'), { staleMs: STALE, now: NOW });
    assert.equal(features.length, 5);
    assert.deepEqual(features.map((f) => f.properties.callsign), [
        'TFR 6/2481 A1500', 'TFR 6/2481 B1000', 'TFR 6/2481 C', 'TFR 6/2481 D FL320', 'TFR 6/2481 Area E'
    ]);
    assert.equal(new Set(features.map((f) => f.id)).size, 5);
    assert.match(features[0].properties.remarks!, /to FL430/);
});

test('toFeatures - eastern hemisphere (Guam)', () => {
    const features = toFeatures(item('6/2520'), fixture('6_2520.xml'), { staleMs: STALE, now: NOW });
    assert.ok(features.length >= 1);
    const ring = (features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    assert.ok(ring.every(([lon]) => lon > 144 && lon < 146));
});

test('toFeatures - shapeless TFR posts nothing', () => {
    assert.deepEqual(toFeatures(item('6/9954'), fixture('6_9954.xml'), { staleMs: STALE, now: NOW }), []);
});

test('toFeatures - stale never outlives the TFR, expired TFRs are dropped', () => {
    // 6/2204 expires 2026-11-02T02:00Z
    const late = new Date('2026-11-02T01:30:00Z');
    const [f] = toFeatures(item('6/2204'), fixture('6_2204.xml'), { staleMs: STALE, now: late });
    assert.equal(f.properties.stale, '2026-11-02T02:00:00.000Z');

    const after = new Date('2026-11-02T02:00:01Z');
    assert.deepEqual(toFeatures(item('6/2204'), fixture('6_2204.xml'), { staleMs: STALE, now: after }), []);
});

test('toFeatures - rejects a non XNOTAM document', () => {
    assert.throws(() => toFeatures(item('6/2204'), '<html></html>', { staleMs: STALE, now: NOW }));
});

test('mapLimit - preserves order and bounds concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3);
});
