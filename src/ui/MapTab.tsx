import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useApp } from '../store/store'
import type { AreaUnitId } from '../types'

export function MapTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const setLocation = useApp(s => s.setLocation);
  const setArea = useApp(s => s.setArea);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [latIn, setLatIn] = useState(ds?.location?.lat?.toString() ?? '');
  const [lonIn, setLonIn] = useState(ds?.location?.lon?.toString() ?? '');
  const [areaIn, setAreaIn] = useState(ds?.area?.value?.toString() ?? '');
  const [areaUnit, setAreaUnit] = useState<AreaUnitId>(ds?.area?.unit ?? 'km2');

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current).setView(ds?.location ? [ds.location.lat, ds.location.lon] : [45, -80], ds?.location ? 9 : 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      const lat = +e.latlng.lat.toFixed(5), lon = +e.latlng.lng.toFixed(5);
      setLocation(lat, lon);
      setLatIn(String(lat)); setLonIn(String(lon));
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
    if (ds?.location) {
      markerRef.current = L.circleMarker([ds.location.lat, ds.location.lon], {
        radius: 9, color: '#0b6e99', fillColor: '#56B4E9', fillOpacity: 0.85, weight: 2,
      }).addTo(map).bindPopup(`${ds.name}<br>${ds.location.lat.toFixed(4)}, ${ds.location.lon.toFixed(4)}`);
    }
  }, [ds?.location?.lat, ds?.location?.lon, ds?.id]);

  if (!ds) return null;

  return (
    <div>
      <section className="card">
        <h2>Station</h2>
        <div className="controls">
          <label>Lat <input value={latIn} onChange={e => setLatIn(e.target.value)} style={{ width: '7em' }} /></label>
          <label>Lon <input value={lonIn} onChange={e => setLonIn(e.target.value)} style={{ width: '7em' }} /></label>
          <button className="primary" onClick={() => {
            const la = Number(latIn), lo = Number(lonIn);
            if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
              setLocation(la, lo);
              mapRef.current?.setView([la, lo], Math.max(mapRef.current.getZoom(), 9));
            }
          }}>Set</button>
          <span className="muted">…or just click the map.</span>
        </div>
        <div className="controls">
          <label>Catchment area <input value={areaIn} onChange={e => setAreaIn(e.target.value)} style={{ width: '7em' }} /></label>
          <select aria-label="Area unit" value={areaUnit} onChange={e => setAreaUnit(e.target.value as AreaUnitId)}>
            <option value="km2">km²</option><option value="mi2">mi²</option>
            <option value="ha">ha</option><option value="acre">acre</option>
          </select>
          <button onClick={() => { const v = Number(areaIn); if (isFinite(v) && v > 0) setArea(v, areaUnit); }}>Save area</button>
          <span className="muted">{ds.area ? `saved: ${ds.area.value} ${ds.area.unit}` : 'needed only for depth ↔ volume unit conversions'}</span>
        </div>
      </section>
      <section className="card">
        <div className="controls">
          <button disabled title="Planned feature; not active yet">Add gauge station (SHP or KML/KMZ) <span className="badge">beta</span></button>
          <button disabled title="Planned feature; not active yet">Add catchment (SHP or KML/KMZ) <span className="badge">beta</span></button>
        </div>
        <div ref={hostRef} className="maphost" />
      </section>
    </div>
  );
}
