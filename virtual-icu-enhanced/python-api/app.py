# ============================================================
#  virtual-icu / python-api / app.py
#  Python Flask Backend — REST API + MongoDB
#  Runs on port 5000
# ============================================================

from flask import Flask, request, jsonify, session
from flask_cors import CORS
from flask_pymongo import PyMongo
from bson.objectid import ObjectId
from datetime import datetime
import uuid
import os

app = Flask(__name__)

# ── Session config (cross-origin between port 3000 and 5000) ─
app.secret_key        = "virtual-icu-flask-secret-2024"
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"]   = False   # False because we're on HTTP (localhost)
app.config["SESSION_COOKIE_HTTPONLY"] = True

# ── CORS ─────────────────────────────────────────────────────
CORS(app,
     supports_credentials=True,
     origins=["http://localhost:3000"],
     allow_headers=["Content-Type"],
     methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"])

# ── MongoDB ──────────────────────────────────────────────────
app.config["MONGO_URI"] = os.environ.get(
    "MONGO_URI", "mongodb://localhost:27017/virtual_icu"
)
mongo = PyMongo(app)

# ── Helper: MongoDB doc → JSON dict ──────────────────────────
def doc(d):
    if d is None:
        return None
    d = dict(d)
    d["id"] = str(d.pop("_id"))
    return d

def doc_list(cursor):
    return [doc(d) for d in cursor]


# ============================================================
#  SEED — inserts default data if DB is empty
# ============================================================
def seed_database():
    # Drop and reseed users every time so credentials are always fresh
    if mongo.db.users.count_documents({}) ==0:
      mongo.db.users.insert_many([
        {"userId": "a1", "name": "Admin",         "role": "admin",  "email": "admin@hospital.com",   "password": "admin123",  "patientId": None},
        {"userId": "n1", "name": "Nurse Kavitha", "role": "nurse",  "email": "kavitha@hospital.com", "password": "nurse123",  "patientId": None},
        {"userId": "n2", "name": "Nurse Preethi", "role": "nurse",  "email": "preethi@hospital.com", "password": "nurse123",  "patientId": None},
        {"userId": "f1", "name": "Priya Ramesh",  "role": "family", "email": "priya@gmail.com",      "password": "family123", "patientId": None},
        {"userId": "f2", "name": "Nisha Sharma",  "role": "family", "email": "nisha@gmail.com",      "password": "family123", "patientId": None},
      ])
      print("[DB] Users seeded")

    # Seed patients only if empty
    if mongo.db.patients.count_documents({}) == 0:
        mongo.db.patients.insert_many([
            {"name": "Mr. Ramesh Kumar",  "bed": "ICU-4", "ward": "Cardiac ICU",  "condition": "Recovering", "visitAllowed": True,  "nurseId": "n1"},
            {"name": "Mrs. Lakshmi Devi", "bed": "ICU-2", "ward": "Neuro ICU",    "condition": "Critical",   "visitAllowed": False, "nurseId": "n1"},
            {"name": "Mr. Arjun Sharma",  "bed": "ICU-7", "ward": "Surgical ICU", "condition": "Stable",     "visitAllowed": True,  "nurseId": "n2"},
            {"name": "Mrs. Sunita Patel", "bed": "ICU-1", "ward": "Cardiac ICU",  "condition": "Critical",   "visitAllowed": False, "nurseId": "n2"},
            {"name": "Mr. Vijay Mehta",   "bed": "ICU-9", "ward": "General ICU",  "condition": "Recovering", "visitAllowed": True,  "nurseId": "n1"},
        ])
        print("[DB] Patients seeded")

    # Link family → patient
    p1 = mongo.db.patients.find_one({"name": "Mr. Ramesh Kumar"})
    p3 = mongo.db.patients.find_one({"name": "Mr. Arjun Sharma"})
    if p1:
        mongo.db.users.update_one({"userId": "f1"}, {"$set": {"patientId": str(p1["_id"])}})
    if p3:
        mongo.db.users.update_one({"userId": "f2"}, {"$set": {"patientId": str(p3["_id"])}})

    # Seed sessions only if empty
    if mongo.db.sessions.count_documents({}) == 0 and p1:
        p3r = mongo.db.patients.find_one({"name": "Mr. Arjun Sharma"})
        p4  = mongo.db.patients.find_one({"name": "Mrs. Sunita Patel"})
        p5  = mongo.db.patients.find_one({"name": "Mr. Vijay Mehta"})
        mongo.db.sessions.insert_many([
            {"patientId": str(p5["_id"]) if p5 else "", "familyId": "f1", "scheduledTime": "09:00 AM", "status": "ended",     "roomId": "room-001", "duration": 20,   "createdAt": datetime.utcnow()},
            {"patientId": str(p3r["_id"]) if p3r else "", "familyId": "f2", "scheduledTime": "10:30 AM", "status": "ended",   "roomId": "room-002", "duration": 18,   "createdAt": datetime.utcnow()},
            {"patientId": str(p1["_id"]),                  "familyId": "f1", "scheduledTime": "02:00 PM", "status": "scheduled","roomId": "room-003", "duration": None, "createdAt": datetime.utcnow()},
            {"patientId": str(p4["_id"]) if p4 else "",   "familyId": "f2", "scheduledTime": "03:30 PM", "status": "scheduled","roomId": "room-004", "duration": None, "createdAt": datetime.utcnow()},
        ])
        print("[DB] Sessions seeded")

    # Seed visit requests only if empty
    if mongo.db.visit_requests.count_documents({}) == 0:
        p2 = mongo.db.patients.find_one({"name": "Mrs. Lakshmi Devi"})
        p3r = mongo.db.patients.find_one({"name": "Mr. Arjun Sharma"})
        p4  = mongo.db.patients.find_one({"name": "Mrs. Sunita Patel"})
        mongo.db.visit_requests.insert_many([
            {"patientId": str(p2["_id"])  if p2  else "", "familyId": "f1", "familyName": "Meera Nair",    "requestedTime": "Tomorrow 10:00 AM", "status": "pending", "note": "Grandchildren want to say hello", "createdAt": datetime.utcnow()},
            {"patientId": str(p3r["_id"]) if p3r else "", "familyId": "f2", "familyName": "Suresh Sharma", "requestedTime": "Today 4:00 PM",    "status": "pending", "note": "",                                 "createdAt": datetime.utcnow()},
            {"patientId": str(p4["_id"])  if p4  else "", "familyId": "f1", "familyName": "Divya Patel",   "requestedTime": "Tomorrow 11:00 AM","status": "pending", "note": "",                                 "createdAt": datetime.utcnow()},
        ])
        print("[DB] Visit requests seeded")

    print("[DB] ✅ Database ready!")
    # Print all users for verification
    print("[DB] Users in database:")
    for u in mongo.db.users.find():
        print(f"       {u['email']} / {u['password']} ({u['role']})")


# ============================================================
#  AUTH ROUTES
# ============================================================

@app.route("/api/login", methods=["POST"])
def login():
    data     = request.get_json()
    email    = data.get("email", "").strip().lower()
    password = data.get("password", "").strip()

    print(f"[LOGIN] Attempt: {email} / {password}")

    # Case-insensitive email search
    user = mongo.db.users.find_one({
        "email":    {"$regex": f"^{email}$", "$options": "i"},
        "password": password
    })

    if not user:
        print(f"[LOGIN] FAILED for {email}")
        return jsonify({"error": "Invalid email or password"}), 401

    session["userId"]   = user["userId"]
    session["userRole"] = user["role"]
    print(f"[LOGIN] SUCCESS: {user['name']} ({user['role']})")

    return jsonify({
        "success": True,
        "user": {
            "id":        user["userId"],
            "name":      user["name"],
            "role":      user["role"],
            "email":     user["email"],
            "patientId": user.get("patientId")
        }
    })


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})


@app.route("/api/me", methods=["GET"])
def me():
    uid = session.get("userId")
    if not uid:
        return jsonify({"error": "Not logged in"}), 401
    user = mongo.db.users.find_one({"userId": uid})
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "id":        user["userId"],
        "name":      user["name"],
        "role":      user["role"],
        "email":     user["email"],
        "patientId": user.get("patientId")
    })


# ── Debug: verify DB has users ────────────────────────────────
@app.route("/api/debug/users", methods=["GET"])
def debug_users():
    users = []
    for u in mongo.db.users.find():
        users.append({
            "email":    u["email"],
            "password": u["password"],
            "role":     u["role"]
        })
    return jsonify({"count": len(users), "users": users})


# ============================================================
#  PATIENT ROUTES
# ============================================================

@app.route("/api/patients", methods=["GET"])
def get_patients():
    return jsonify(doc_list(mongo.db.patients.find()))


@app.route("/api/patients/<patient_id>", methods=["GET"])
def get_patient(patient_id):
    try:
        p = mongo.db.patients.find_one({"_id": ObjectId(patient_id)})
    except Exception:
        return jsonify({"error": "Invalid ID"}), 400
    if not p:
        return jsonify({"error": "Patient not found"}), 404
    return jsonify(doc(p))


@app.route("/api/patients/<patient_id>/visit-access", methods=["PATCH"])
def toggle_visit_access(patient_id):
    data = request.get_json()
    allow = data.get("visitAllowed", False)
    try:
        mongo.db.patients.update_one({"_id": ObjectId(patient_id)}, {"$set": {"visitAllowed": allow}})
        p = doc(mongo.db.patients.find_one({"_id": ObjectId(patient_id)}))
    except Exception:
        return jsonify({"error": "Invalid ID"}), 400
    return jsonify({"success": True, "patient": p})


# ============================================================
#  VISIT REQUEST ROUTES
# ============================================================

@app.route("/api/visit-requests", methods=["GET"])
def get_visit_requests():
    reqs = list(mongo.db.visit_requests.find())
    enriched = []
    for r in reqs:
        r = doc(r)
        try:
            p = mongo.db.patients.find_one({"_id": ObjectId(r["patientId"])})
            r["patient"] = doc(p) if p else None
        except Exception:
            r["patient"] = None
        enriched.append(r)
    return jsonify(enriched)


@app.route("/api/visit-requests", methods=["POST"])
def create_visit_request():
    data       = request.get_json()
    patient_id = data.get("patientId", "")
    try:
        patient = mongo.db.patients.find_one({"_id": ObjectId(patient_id)})
    except Exception:
        return jsonify({"error": "Invalid patient ID"}), 400
    if not patient:
        return jsonify({"error": "Patient not found"}), 404
    if not patient.get("visitAllowed", False):
        return jsonify({"error": "Visits not permitted for this patient"}), 403

    new_req = {
        "patientId":     patient_id,
        "familyId":      data.get("familyId", ""),
        "familyName":    data.get("familyName", ""),
        "requestedTime": data.get("requestedTime", ""),
        "note":          data.get("note", ""),
        "status":        "pending",
        "createdAt":     datetime.utcnow()
    }
    result = mongo.db.visit_requests.insert_one(new_req)
    new_req["id"] = str(result.inserted_id)
    new_req.pop("_id", None)
    return jsonify({"success": True, "request": new_req}), 201


@app.route("/api/visit-requests/<req_id>", methods=["PATCH"])
def update_visit_request(req_id):
    data   = request.get_json()
    status = data.get("status")
    try:
        mongo.db.visit_requests.update_one({"_id": ObjectId(req_id)}, {"$set": {"status": status}})
        vr = doc(mongo.db.visit_requests.find_one({"_id": ObjectId(req_id)}))
    except Exception:
        return jsonify({"error": "Invalid ID"}), 400

    if status == "approved":
        room_id     = "room-" + str(uuid.uuid4())[:8]
        new_session = {
            "patientId":     vr["patientId"],
            "familyId":      vr["familyId"],
            "scheduledTime": vr["requestedTime"],
            "status":        "scheduled",
            "roomId":        room_id,
            "duration":      None,
            "createdAt":     datetime.utcnow()
        }
        result = mongo.db.sessions.insert_one(new_session)
        new_session["id"] = str(result.inserted_id)
        new_session.pop("_id", None)
        return jsonify({"success": True, "request": vr, "session": new_session})

    return jsonify({"success": True, "request": vr})


# ============================================================
#  SESSION ROUTES
# ============================================================

@app.route("/api/sessions", methods=["GET"])
def get_sessions():
    sessions_list = list(mongo.db.sessions.find())
    enriched = []
    for s in sessions_list:
        s = doc(s)
        try:
            p = mongo.db.patients.find_one({"_id": ObjectId(s["patientId"])})
            s["patient"] = doc(p) if p else None
        except Exception:
            s["patient"] = None
        f = mongo.db.users.find_one({"userId": s.get("familyId")})
        s["family"] = {"name": f["name"], "email": f["email"]} if f else None
        enriched.append(s)
    return jsonify(enriched)


@app.route("/api/sessions/room/<room_id>", methods=["GET"])
def get_session_by_room(room_id):
    s = mongo.db.sessions.find_one({"roomId": room_id})
    if not s:
        return jsonify({"error": "Session not found"}), 404
    s = doc(s)
    try:
        p = mongo.db.patients.find_one({"_id": ObjectId(s["patientId"])})
        s["patient"] = doc(p) if p else None
    except Exception:
        s["patient"] = None
    return jsonify(s)


@app.route("/api/sessions/<session_id>/status", methods=["PATCH"])
def update_session_status(session_id):
    data   = request.get_json()
    update = {"status": data.get("status")}
    if data.get("duration"):
        update["duration"] = data["duration"]
    try:
        mongo.db.sessions.update_one({"_id": ObjectId(session_id)}, {"$set": update})
        s = doc(mongo.db.sessions.find_one({"_id": ObjectId(session_id)}))
    except Exception:
        return jsonify({"error": "Invalid ID"}), 400
    return jsonify({"success": True, "session": s})


# ============================================================
#  STATS
# ============================================================

@app.route("/api/stats", methods=["GET"])
def get_stats():
    return jsonify({
        "totalPatients":   mongo.db.patients.count_documents({}),
        "activeSessions":  mongo.db.sessions.count_documents({"status": "live"}),
        "scheduledToday":  mongo.db.sessions.count_documents({"status": "scheduled"}),
        "pendingRequests": mongo.db.visit_requests.count_documents({"status": "pending"}),
        "completedToday":  mongo.db.sessions.count_documents({"status": "ended"}),
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "Virtual ICU Flask API", "port": 5000})


# ============================================================
#  START
# ============================================================
if __name__ == "__main__":
    with app.app_context():
        seed_database()
    print("\n🏥  Flask API → http://localhost:5000")
    print("🍃  MongoDB  → virtual_icu database\n")
    app.run(debug=True, port=5000)
