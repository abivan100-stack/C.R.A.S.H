import { useEffect, useRef } from 'react';

import { isValidLandPoint } from '../domain/pick.ts';
import { nearestArea } from '../domain/geo.ts';
import type { AccidentRecord } from '../domain/engine.ts';
import { addBaseLayer, limitToChennai, refreshBaseLayer, type Theme } from '../lib/maptiler.ts';

interface Props {
  theme: Theme;
  records: readonly AccidentRecord[];
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number, area: string | null) => void;
  onInvalid: (message: string) => void;
}

/** The report form's pin-drop map: click or drag to choose the accident spot. */
export function ReportMapPicker({ theme, records, lat, lng, onPick, onInvalid }: Props): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const layer = useRef<any>(null);
  const marker = useRef<any>(null);
  const pickCb = useRef({ onPick, onInvalid, records });
  pickCb.current = { onPick, onInvalid, records };

  useEffect(() => {
    if (!el.current || map.current) return;
    const instance = L.map(el.current, {
      center: [13.05, 80.23],
      zoom: 11,
      zoomControl: true,
      attributionControl: false,
      zoomSnap: 0.25,
      minZoom: 10,
      maxZoom: 18,
    });
    map.current = instance;
    layer.current = addBaseLayer(instance, theme);
    limitToChennai(instance);

    const choose = (plat: number, plng: number): void => {
      if (!isValidLandPoint(plat, plng)) {
        pickCb.current.onInvalid('Please select a location on land within Chennai.');
        return;
      }
      const area = nearestArea(pickCb.current.records, plat, plng);
      place(plat, plng);
      pickCb.current.onPick(plat, plng, area);
    };

    const place = (plat: number, plng: number): void => {
      if (marker.current) {
        marker.current.setLatLng([plat, plng]);
        return;
      }
      marker.current = L.marker([plat, plng], { draggable: true }).addTo(instance);
      marker.current.on('dragend', (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
        const point = e.target.getLatLng();
        choose(point.lat, point.lng);
      });
    };

    instance.on('click', (e: { latlng: { lat: number; lng: number } }) => choose(e.latlng.lat, e.latlng.lng));
    const timer = setTimeout(() => instance.invalidateSize(), 0);
    return () => {
      clearTimeout(timer);
      instance.remove();
      map.current = null;
      layer.current = null;
      marker.current = null;
    };
    // The map is created once; handlers read the latest props through pickCb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshBaseLayer(layer.current, theme);
  }, [theme]);

  useEffect(() => {
    if (!map.current || lat == null || lng == null) return;
    if (marker.current) marker.current.setLatLng([lat, lng]);
    else marker.current = L.marker([lat, lng], { draggable: true }).addTo(map.current);
  }, [lat, lng]);

  return <div id="reportMap" className="af-map" ref={el} />;
}

export function locateMe(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}
