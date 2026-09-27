import { GOOGLE_MAP_ID } from '../config';
import { loadGoogle } from '../google';
import { offsetLatLon, type LatLon } from '../geo';

// 左側地圖（Google Maps）：搜尋任何地點、點一下移動、Shift＋點一下對準、
// 拖曳相機標記移動、拖曳橘色把手轉向；畫出視角扇形、近景／遠景範圍與方向線。

export interface MapSync {
  eye: LatLon;
  azimuth: number;
  hfov: number;
  near: number;
  range: number;
  sunAz: number;
  sunUp: boolean;
  moonAz: number | null;
  target: { label: string; at: LatLon } | null;
}

export interface MapHooks {
  moveTo(p: LatLon): void;
  aimAt(p: LatLon): void;
  place(p: LatLon, viewport?: google.maps.LatLngBounds | null): void;
}

const DEG = Math.PI / 180;

function bearingLL(a: LatLon, b: LatLon): number {
  const e = (b.lon - a.lon) * Math.cos(a.lat * DEG);
  const n = b.lat - a.lat;
  return ((Math.atan2(e, n) / DEG) + 360) % 360;
}

export class GoogleMapView {
  map: google.maps.Map | null = null;
  error: string | null = null;
  /** 驗證失敗等情況下停用：不再更新圖層 */
  disabled = false;
  private cam!: google.maps.marker.AdvancedMarkerElement;
  private aim!: google.maps.marker.AdvancedMarkerElement;
  private wedge!: google.maps.Polygon;
  private nearCircle!: google.maps.Circle;
  private farCircle!: google.maps.Circle;
  private rays: Record<'sun' | 'moon' | 'target', google.maps.Polyline> = {} as never;
  private last: MapSync | null = null;
  private dragging = false;

  constructor(private el: HTMLElement, private searchHost: HTMLElement, private hooks: MapHooks) {}

  async init(center: LatLon) {
    try {
      const [{ Map, Polygon, Polyline, Circle }, { AdvancedMarkerElement }] = await Promise.all([loadGoogle('maps'), loadGoogle('marker')]);
      const map = new Map(this.el, {
        center: { lat: center.lat, lng: center.lon },
        zoom: 16,
        mapId: GOOGLE_MAP_ID,
        // 點陣地圖相容性較好（向量地圖在部分 GPU／瀏覽器上疊加圖層會消失）
        renderingType: google.maps.RenderingType.RASTER,
        clickableIcons: false,
        gestureHandling: 'greedy',
        streetViewControl: false,
        fullscreenControl: false,
        rotateControl: false,
        cameraControl: false,
        mapTypeControl: true,
        mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT, style: google.maps.MapTypeControlStyle.DROPDOWN_MENU },
        tilt: 0,
      });
      this.map = map;

      const ring = (color: string, opacity: number) =>
        new Circle({ map, strokeColor: color, strokeOpacity: opacity, strokeWeight: 1.5, fillOpacity: 0, clickable: false, center: map.getCenter()!, radius: 1 });
      this.farCircle = ring('#ffffff', 0.5);
      this.nearCircle = ring('#5fe0bf', 0.9);
      this.wedge = new Polygon({ map, strokeColor: '#ffb020', strokeWeight: 1.5, strokeOpacity: 0.9, fillColor: '#ffb020', fillOpacity: 0.16, clickable: false });
      const line = (color: string, dashed: boolean) =>
        new Polyline({
          map,
          clickable: false,
          strokeColor: color,
          strokeOpacity: dashed ? 0 : 0.9,
          strokeWeight: 2,
          icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.95, strokeColor: color, scale: 2 }, offset: '0', repeat: '10px' }] : undefined,
        });
      this.rays = { sun: line('#ffbf3c', false), moon: line('#c9d6ff', true), target: line('#5fe0bf', true) };

      const dot = (cls: string) => {
        const d = document.createElement('div');
        d.className = cls;
        return d;
      };
      this.cam = new AdvancedMarkerElement({ map, content: dot('gm-cam'), gmpDraggable: true, zIndex: 10, title: '相機位置（可拖曳）' });
      this.aim = new AdvancedMarkerElement({ map, content: dot('gm-aim'), gmpDraggable: true, zIndex: 11, title: '拖曳以轉向' });

      const ll = (p: google.maps.LatLng | google.maps.LatLngLiteral | null | undefined): LatLon | null => {
        if (!p) return null;
        const lat = typeof p.lat === 'function' ? (p as google.maps.LatLng).lat() : (p as google.maps.LatLngLiteral).lat;
        const lng = typeof p.lng === 'function' ? (p as google.maps.LatLng).lng() : (p as google.maps.LatLngLiteral).lng;
        return { lat, lon: lng };
      };
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        const p = ll(e.latLng);
        if (!p) return;
        if ((e.domEvent as MouseEvent | undefined)?.shiftKey) this.hooks.aimAt(p);
        else this.hooks.moveTo(p);
      });
      this.cam.addEventListener('gmp-dragstart', () => (this.dragging = true));
      this.cam.addEventListener('gmp-drag', () => {
        const p = ll(this.cam.position as google.maps.LatLngLiteral);
        if (p) this.hooks.moveTo(p);
      });
      this.cam.addEventListener('gmp-dragend', () => (this.dragging = false));
      this.aim.addEventListener('gmp-drag', () => {
        const p = ll(this.aim.position as google.maps.LatLngLiteral);
        if (p) this.hooks.aimAt(p);
      });
      this.aim.addEventListener('gmp-dragend', () => this.last && this.sync(this.last));
      map.addListener('zoom_changed', () => this.last && this.sync(this.last));

      await this.initSearch();
      if (this.last) this.sync(this.last);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      console.warn('[map] Google 地圖載入失敗', e);
      throw e;
    }
  }

  private async initSearch() {
    try {
      const { PlaceAutocompleteElement } = await loadGoogle('places');
      const ac = new PlaceAutocompleteElement({});
      ac.id = 'place-autocomplete';
      ac.setAttribute('placeholder', '搜尋地點或地址…');
      this.searchHost.prepend(ac);
      ac.addEventListener('gmp-select', async (ev) => {
        const pred = (ev as unknown as google.maps.places.PlacePredictionSelectEvent).placePrediction;
        const place = pred.toPlace();
        await place.fetchFields({ fields: ['location', 'viewport', 'displayName'] });
        const loc = place.location;
        if (loc) this.hooks.place({ lat: loc.lat(), lon: loc.lng() }, place.viewport ?? null);
      });
    } catch (e) {
      console.warn('[map] 地點搜尋無法使用', e);
    }
  }

  /** 每公尺多少像素的反數：目前縮放下一像素代表幾公尺 */
  private metersPerPixel(lat: number): number {
    const z = this.map?.getZoom() ?? 16;
    return (156543.03392 * Math.cos(lat * DEG)) / 2 ** z;
  }

  sync(s: MapSync) {
    this.last = s;
    if (!this.map || this.disabled) return;
    const eye = { lat: s.eye.lat, lng: s.eye.lon };
    if (!this.dragging) this.cam.position = eye;
    const mpp = this.metersPerPixel(s.eye.lat);
    const at = (az: number, dist: number) => {
      const p = offsetLatLon(s.eye, Math.sin(az * DEG) * dist, Math.cos(az * DEG) * dist);
      return { lat: p.lat, lng: p.lon };
    };
    this.aim.position = at(s.azimuth, 52 * mpp);

    const R = Math.min(60000, 2400 * mpp);
    const path = [eye];
    for (let k = 0; k <= 16; k++) path.push(at(s.azimuth - s.hfov / 2 + (s.hfov * k) / 16, R));
    this.wedge.setPath(path);

    this.nearCircle.setCenter(eye);
    this.nearCircle.setRadius(s.near);
    this.farCircle.setCenter(eye);
    this.farCircle.setRadius(s.range);

    this.rays.sun.setOptions({ strokeOpacity: s.sunUp ? 0.9 : 0.35 });
    this.rays.sun.setPath([eye, at(s.sunAz, R)]);
    this.rays.moon.setVisible(s.moonAz !== null);
    if (s.moonAz !== null) this.rays.moon.setPath([eye, at(s.moonAz, R)]);
    this.rays.target.setVisible(Boolean(s.target));
    if (s.target) {
      const t = s.target.at;
      const d = Math.hypot((t.lat - s.eye.lat) * 110574, (t.lon - s.eye.lon) * 111320 * Math.cos(s.eye.lat * DEG));
      this.rays.target.setPath([eye, d < R ? { lat: t.lat, lng: t.lon } : at(bearingLL(s.eye, t), R)]);
    }

    // 相機移出畫面時跟著平移
    const b = this.map.getBounds();
    if (b && !this.dragging && !b.contains(eye)) this.map.panTo(eye);
  }

  panTo(p: LatLon, viewport?: google.maps.LatLngBounds | null) {
    if (!this.map || this.disabled) return;
    if (viewport) this.map.fitBounds(viewport);
    else this.map.panTo({ lat: p.lat, lng: p.lon });
    if ((this.map.getZoom() ?? 16) < 15) this.map.setZoom(16);
  }
}
