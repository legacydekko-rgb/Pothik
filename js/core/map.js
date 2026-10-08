/* ==========================================================================
   Pothik — Map wrapper around Leaflet + OpenStreetMap
   --------------------------------------------------------------------------
   Default provider: Leaflet + OSM raster tiles + OSRM routing.
   This requires NO API key and works out of the box.
   To switch to Google Maps, set Settings.googleMapsApiKey and load the Google
   Maps JS API — see docs/API-KEYS.md. The wrapper API stays identical:
     const m = PothikMap.create(el, {center, zoom});
     m.setPickup(latlng); m.setDropoff(latlng); m.setDriver(latlng, heading);
     m.drawRoute([[lat,lng],...]); m.fitAll();
   ========================================================================== */
(function (global) {
  'use strict';

  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function hasLeaflet() { return typeof global.L === 'object' && global.L !== null; }

  function pinIcon(kind, heading) {
    const cls = kind === 'car' ? 'p-car' : (kind === 'cng' ? 'p-cng' : 'p-bike');
    const icon = kind === 'car' ? 'fa-car-side' : (kind === 'cng' ? 'fa-taxi' : 'fa-motorcycle');
    const rot = heading ? ' transform: rotate(' + heading + 'deg);' : '';
    return global.L.divIcon({
      className: '',
      html: '<div class="veh-pin ' + cls + '"><i class="fa-solid ' + icon + '" style="' + rot + '"></i></div>',
      iconSize: [38, 38],
      iconAnchor: [19, 34]
    });
  }

  function dotIcon(color, size, ring) {
    const s = size || 16;
    return global.L.divIcon({
      className: '',
      html: '<div style="width:' + s + 'px;height:' + s + 'px;border-radius:50%;background:' + color +
        ';border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)' + (ring ? ';box-shadow:0 0 0 6px ' + ring : '') + '"></div>',
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2]
    });
  }

  class PothikMap {
    constructor(node, opts) {
      const o = opts || {};
      this.node = typeof node === 'string' ? document.getElementById(node) : node;
      if (!this.node) throw new Error('Map container not found');
      if (!hasLeaflet()) {
        this.node.innerHTML = '<div class="empty" style="padding:24px">' +
          '<i class="fa-solid fa-map"></i><h3>Map unavailable</h3>' +
          '<p style="font-size:13px">Leaflet failed to load. Check your connection.</p></div>';
        this.broken = true;
        return;
      }
      this.map = global.L.map(this.node, {
        zoomControl: o.zoomControl !== false,
        attributionControl: true,
        preferCanvas: true
      }).setView([(o.center && o.center.lat) || global.PothikGeo.BD.center.lat,
                  (o.center && o.center.lng) || global.PothikGeo.BD.center.lng],
                 o.zoom || 13);

      global.L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19, detectRetina: true }).addTo(this.map);

      this.markers = {};
      this.routeLine = null;
      this.driverTrail = null;
      this.circle = null;
      this._onClick = null;
      this._onMoveEnd = null;
    }

    /* ------------------------------------------------------------ markers */
    setPickup(latlng, label) {
      if (this.broken) return;
      if (this.markers.pickup) this.markers.pickup.setLatLng([latlng.lat, latlng.lng]);
      else {
        this.markers.pickup = global.L.marker([latlng.lat, latlng.lng], { icon: dotIcon('#0A7C5A', 18, 'rgba(10,124,90,.22)') }).addTo(this.map);
      }
      if (label) this.markers.pickup.bindPopup('<strong>' + global.UI.esc(label) + '</strong>');
      return this.markers.pickup;
    }

    setDropoff(latlng, label) {
      if (this.broken) return;
      if (this.markers.dropoff) this.markers.dropoff.setLatLng([latlng.lat, latlng.lng]);
      else {
        this.markers.dropoff = global.L.marker([latlng.lat, latlng.lng], { icon: dotIcon('#FF5A36', 18, 'rgba(255,90,54,.22)') }).addTo(this.map);
      }
      if (label) this.markers.dropoff.bindPopup('<strong>' + global.UI.esc(label) + '</strong>');
      return this.markers.dropoff;
    }

    setDriver(latlng, vehicleType, heading) {
      if (this.broken) return;
      const icon = pinIcon(vehicleType || 'car', heading);
      if (this.markers.driver) {
        this.markers.driver.setLatLng([latlng.lat, latlng.lng]);
        this.markers.driver.setIcon(icon);
      } else {
        this.markers.driver = global.L.marker([latlng.lat, latlng.lng], { icon: icon, zIndexOffset: 500 }).addTo(this.map);
      }
      return this.markers.driver;
    }

    setSelf(latlng) {
      if (this.broken) return;
      if (this.markers.self) this.markers.self.setLatLng([latlng.lat, latlng.lng]);
      else this.markers.self = global.L.marker([latlng.lat, latlng.lng], { icon: dotIcon('#2B7FFF', 18, 'rgba(43,127,255,.22)') }).addTo(this.map);
      return this.markers.self;
    }

    /** Generic marker pool keyed by id — used for nearby-driver pins. */
    setMarker(id, latlng, vehicleType, heading) {
      if (this.broken) return;
      if (this.markers[id]) {
        this.markers[id].setLatLng([latlng.lat, latlng.lng]);
        this.markers[id].setIcon(pinIcon(vehicleType, heading));
      } else {
        this.markers[id] = global.L.marker([latlng.lat, latlng.lng], { icon: pinIcon(vehicleType, heading) }).addTo(this.map);
      }
    }

    removeMarker(id) {
      if (this.broken || !this.markers[id]) return;
      this.map.removeLayer(this.markers[id]);
      delete this.markers[id];
    }

    clearMarkersExcept(keep) {
      if (this.broken) return;
      Object.keys(this.markers).forEach((k) => {
        if ((keep || []).indexOf(k) === -1) this.removeMarker(k);
      });
    }

    clearAll() {
      if (this.broken) return;
      Object.keys(this.markers).forEach((k) => this.removeMarker(k));
      this.clearRoute();
      if (this.circle) { this.map.removeLayer(this.circle); this.circle = null; }
    }

    /* -------------------------------------------------------------- route */
    drawRoute(polyline, color, dashed) {
      if (this.broken || !polyline || !polyline.length) return;
      if (this.routeLine) this.map.removeLayer(this.routeLine);
      this.routeLine = global.L.polyline(polyline, {
        color: color || '#0A7C5A',
        weight: 5,
        opacity: 0.92,
        lineJoin: 'round',
        lineCap: 'round',
        dashArray: dashed ? '8 10' : null
      }).addTo(this.map);
    }

    clearRoute() {
      if (this.routeLine) { this.map.removeLayer(this.routeLine); this.routeLine = null; }
    }

    drawTrail(points) {
      if (this.broken || !points || points.length < 2) return;
      if (this.driverTrail) this.map.removeLayer(this.driverTrail);
      this.driverTrail = global.L.polyline(points, { color: '#2B7FFF', weight: 4, opacity: 0.7, dashArray: '6 8' }).addTo(this.map);
    }

    drawRadius(center, km) {
      if (this.broken) return;
      if (this.circle) this.map.removeLayer(this.circle);
      this.circle = global.L.circle([center.lat, center.lng], {
        radius: km * 1000, color: '#0A7C5A', weight: 1.5, opacity: 0.5,
        fillColor: '#0A7C5A', fillOpacity: 0.06, interactive: false
      }).addTo(this.map);
    }

    /* ------------------------------------------------------------ viewport */
    fitPoints(points, padding) {
      if (this.broken) return;
      const pts = (points || []).filter(Boolean).map(function (p) { return [p.lat, p.lng]; });
      if (!pts.length) return;
      if (pts.length === 1) { this.map.setView(pts[0], 16); return; }
      this.map.fitBounds(global.L.latLngBounds(pts), { padding: padding || [48, 48], maxZoom: 17 });
    }

    centerOn(latlng, zoom) {
      if (this.broken) return;
      this.map.setView([latlng.lat, latlng.lng], zoom || this.map.getZoom());
    }

    panTo(latlng, animate) {
      if (this.broken) return;
      this.map.panTo([latlng.lat, latlng.lng], { animate: animate !== false });
    }

    invalidate() { if (!this.broken && this.map) this.map.invalidateSize(); }

    onClick(fn) {
      if (this.broken) return;
      if (this._onClick) this.map.off('click', this._onClick);
      this._onClick = function (e) { fn({ lat: e.latlng.lat, lng: e.latlng.lng }); };
      this.map.on('click', this._onClick);
    }

    onMoveEnd(fn) {
      if (this.broken) return;
      if (this._onMoveEnd) this.map.off('moveend', this._onMoveEnd);
      this._onMoveEnd = function () {
        const c = this.map.getCenter();
        fn({ lat: c.lat, lng: c.lng }, this.map.getZoom());
      }.bind(this);
      this.map.on('moveend', this._onMoveEnd);
    }

    getCenter() {
      if (this.broken) return global.PothikGeo.BD.center;
      const c = this.map.getCenter();
      return { lat: c.lat, lng: c.lng };
    }

    getZoom() { return this.broken ? 13 : this.map.getZoom(); }

    destroy() {
      if (this.map) { try { this.map.remove(); } catch (e) {} }
    }
  }

  function create(node, opts) { return new PothikMap(node, opts); }

  global.PothikMap = { create: create, PothikMap: PothikMap, hasLeaflet: hasLeaflet, pinIcon: pinIcon, dotIcon: dotIcon };
})(window);
