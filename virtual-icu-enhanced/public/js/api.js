/* ============================================================
   virtual-icu / public / js / api.js
   All calls to /api/* — same origin, port 3000
   ============================================================ */

const API = {

  async login(email, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return res.json();
  },

  async logout() {
    await fetch('/api/logout', { method: 'POST' });
  },

  async me() {
    const res = await fetch('/api/me');
    return res.ok ? res.json() : null;
  },

  async getPatients() {
    return (await fetch('/api/patients')).json();
  },

  async getPatient(id) {
    return (await fetch(`/api/patients/${id}`)).json();
  },

  async toggleVisitAccess(patientId, allow) {
    const res = await fetch(`/api/patients/${patientId}/visit-access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitAllowed: allow })
    });
    return res.json();
  },

  async getVisitRequests() {
    return (await fetch('/api/visit-requests')).json();
  },

  async submitVisitRequest({ patientId, familyId, familyName, requestedTime, note }) {
    const res = await fetch('/api/visit-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, familyId, familyName, requestedTime, note })
    });
    return { ok: res.ok, data: await res.json() };
  },

  async updateVisitRequest(id, status) {
    const res = await fetch(`/api/visit-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return res.json();
  },

  async getSessions() {
    return (await fetch('/api/sessions')).json();
  },

  async getSessionByRoom(roomId) {
    const res = await fetch(`/api/sessions/room/${roomId}`);
    return res.ok ? res.json() : null;
  },

  async updateSessionStatus(id, status, durationSeconds) {
    const res = await fetch(`/api/sessions/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, duration: durationSeconds })
    });
    return res.json();
  },

  async getStats() {
    return (await fetch('/api/stats')).json();
  }
};
