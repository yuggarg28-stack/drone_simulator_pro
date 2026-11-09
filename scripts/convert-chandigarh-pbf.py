"""Convert a *local* OSM .osm.pbf or .osm file into Overpass-compatible JSON.

Usage:
    py -m pip install osmium
    py scripts/convert-chandigarh-pbf.py "C:\\path\\chandigarh.osm.pbf"
    node scripts/fetch-chandigarh.mjs --input chandigarh-from-pbf.json

Requires pyosmium. Reads local data only and makes no network requests.
"""
import json
import math
import sys
from pathlib import Path

try:
    import osmium
except ImportError:
    raise SystemExit('Missing dependency: run py -m pip install osmium')

BBOX = (30.73665, 76.77835, 30.74349, 76.78683)  # s, w, n, e
ALLOWED_HIGHWAY = {
    'primary', 'secondary', 'tertiary', 'residential', 'service',
    'unclassified', 'living_street', 'pedestrian', 'footway', 'path',
    'cycleway', 'trunk'
}


def touches_bbox(points):
    s, w, n, e = BBOX
    return any(s <= p['lat'] <= n and w <= p['lon'] <= e for p in points)


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.elements = []
        self.seen_buildings = 0
        self.seen_roads = 0

    def way(self, way):
        tags = dict(way.tags)
        is_building = bool(tags.get('building'))
        is_road = tags.get('highway') in ALLOWED_HIGHWAY
        if not (is_building or is_road):
            return
        geometry = []
        for node in way.nodes:
            if not node.location.valid():
                return  # never manufacture an incomplete way from missing nodes
            geometry.append({'lat': node.location.lat, 'lon': node.location.lon})
        if not touches_bbox(geometry):
            return
        self.elements.append({
            'type': 'way', 'id': way.id, 'tags': tags,
            'geometry': geometry
        })
        self.seen_buildings += is_building
        self.seen_roads += is_road


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: py scripts/convert-chandigarh-pbf.py "C:\\path\\chandigarh.osm.pbf"')
    source = Path(sys.argv[1])
    if not source.is_file():
        raise SystemExit(f'PBF not found: {source}')
    dest = Path('chandigarh-from-pbf.json')
    collector = Collector()
    collector.apply_file(str(source), locations=True)
    if collector.seen_buildings < 10 or collector.seen_roads < 5:
        raise SystemExit(f'Insufficient geometry: {collector.seen_buildings} buildings and {collector.seen_roads} roads. Is this a Chandigarh region extract?')
    dest.write_text(json.dumps({'elements': collector.elements}, separators=(',', ':')), encoding='utf-8')
    print(f'Extracted {collector.seen_buildings} building ways and {collector.seen_roads} road ways in Sector 17.')
    print('Saved', dest.resolve())
    print(f'Next: node scripts/fetch-chandigarh.mjs --input {dest}')


if __name__ == '__main__':
    main()
