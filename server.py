"""
NetPulse — app.py v3.0
Real-Time Mobile Network Signal Intelligence Platform
Features: ML Prediction · Dead Zone Detection · Quality Score · API Docs
"""

from flask import Flask, request, jsonify, render_template
import sqlite3, datetime, math, json
from collections import defaultdict

try:
    import numpy as np
    from sklearn.linear_model import LinearRegression
    from sklearn.preprocessing import PolynomialFeatures
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

app     = Flask(__name__)
DB      = 'signals.db'
VERSION = '3.0.0'

# ══ DATABASE ═══════════════════════════════════════════════
def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            signal        REAL,
            network       TEXT DEFAULT 'Unknown',
            operator      TEXT DEFAULT 'Unknown',
            time          TEXT,
            lat           REAL,
            lng           REAL,
            device_id     TEXT DEFAULT 'Unknown',
            quality_score REAL DEFAULT 0
        )
    """)
    for col, typ in [('lat','REAL'),('lng','REAL'),('device_id','TEXT'),('quality_score','REAL')]:
        try:
            c.execute(f"ALTER TABLE signals ADD COLUMN {col} {typ}")
        except Exception:
            pass
    conn.commit()
    conn.close()

init_db()

# ══ HELPERS ════════════════════════════════════════════════
def parse_gps(data):
    lat = (data.get('lat') or data.get('latitude') or data.get('Lat') or data.get('Latitude'))
    lng = (data.get('lng') or data.get('lon') or data.get('longitude') or
           data.get('Longitude') or data.get('Lng') or data.get('Lon'))
    try:    lat = float(lat) if lat is not None else None
    except: lat = None
    try:    lng = float(lng) if lng is not None else None
    except: lng = None
    if lat is not None and math.isnan(lat): lat = None
    if lng is not None and math.isnan(lng): lng = None
    return lat, lng

def compute_quality_score(signal, history):
    """Composite score: Signal 60% + Stability 30% + Uptime 10%"""
    if not history:
        return round(signal * 0.6, 2)
    vals = [r['signal'] for r in history[-20:]]
    if len(vals) > 1:
        mean = sum(vals) / len(vals)
        std  = math.sqrt(sum((v-mean)**2 for v in vals) / len(vals))
        stability = max(0, 100 - (std * 2))
    else:
        stability = 100
    uptime = (sum(1 for v in vals if v >= 30) / len(vals)) * 100
    score  = (signal * 0.6) + (stability * 0.3) + (uptime * 0.1)
    return round(min(100, max(0, score)), 2)

def rows_to_dicts(rows):
    return [dict(r) for r in rows]

# ══ POST /signal ═══════════════════════════════════════════
@app.route('/signal', methods=['POST'])
def receive_signal():
    data   = request.json or {}
    try:    signal = float(data.get('signal', 0))
    except: signal = 0.0
    lat, lng = parse_gps(data)
    device   = data.get('device_id') or data.get('device') or 'Unknown'
    network  = data.get('network',  'Unknown')
    operator = data.get('operator', 'Unknown')
    time_val = data.get('time') or datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    conn   = get_db()
    recent = rows_to_dicts(conn.execute(
        "SELECT signal FROM signals ORDER BY id DESC LIMIT 20").fetchall())
    q_score = compute_quality_score(signal, recent)

    conn.execute("""
        INSERT INTO signals (signal,network,operator,time,lat,lng,device_id,quality_score)
        VALUES (?,?,?,?,?,?,?,?)
    """, (signal, network, operator, time_val, lat, lng, device, q_score))
    conn.commit()
    conn.close()
    return jsonify({"status":"ok","signal":signal,"lat":lat,"lng":lng,"quality_score":q_score})

# ══ GET /signals ════════════════════════════════════════════
@app.route('/signals')
def get_signals():
    limit  = request.args.get('limit', 200, type=int)
    device = request.args.get('device', None)
    conn   = get_db()
    if device:
        rows = conn.execute("""SELECT id,signal,network,operator,time,lat,lng,device_id,quality_score
            FROM signals WHERE device_id=? ORDER BY id DESC LIMIT ?""", (device,limit)).fetchall()
    else:
        rows = conn.execute("""SELECT id,signal,network,operator,time,lat,lng,device_id,quality_score
            FROM signals ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
    conn.close()
    return jsonify(rows_to_dicts(rows))

# ══ GET /stats ══════════════════════════════════════════════
@app.route('/stats')
def get_stats():
    conn = get_db()
    row  = conn.execute("""SELECT COUNT(*) as total, AVG(signal) as avg_signal,
        MAX(signal) as peak, MIN(signal) as min_signal,
        AVG(quality_score) as avg_quality, COUNT(DISTINCT device_id) as devices
        FROM signals""").fetchone()
    hourly = conn.execute("""SELECT strftime('%H',time) as hour,
        AVG(signal) as avg_sig, COUNT(*) as count
        FROM signals GROUP BY hour ORDER BY hour""").fetchall()
    conn.close()
    return jsonify({"total":row['total'],"avg_signal":round(row['avg_signal'] or 0,2),
        "peak":row['peak'] or 0,"min":row['min_signal'] or 0,
        "avg_quality":round(row['avg_quality'] or 0,2),
        "devices":row['devices'],"hourly":rows_to_dicts(hourly)})

# ══ GET /predict (ML) ══════════════════════════════════════
@app.route('/predict')
def predict():
    """Polynomial Regression signal prediction."""
    if not ML_AVAILABLE:
        return jsonify({"error":"scikit-learn not installed"}), 503
    steps = min(request.args.get('steps', 10, type=int), 60)
    conn  = get_db()
    rows  = conn.execute(
        "SELECT signal,time FROM signals ORDER BY id DESC LIMIT 100").fetchall()
    conn.close()
    if len(rows) < 5:
        return jsonify({"error":"Need at least 5 readings","available":len(rows)}), 400

    vals = [r['signal'] for r in reversed(rows)]
    X    = np.array(range(len(vals))).reshape(-1,1)
    y    = np.array(vals)
    poly = PolynomialFeatures(degree=2)
    Xp   = poly.fit_transform(X)
    mdl  = LinearRegression().fit(Xp, y)
    r2   = mdl.score(Xp, y)

    fX   = np.array(range(len(vals), len(vals)+steps)).reshape(-1,1)
    preds = mdl.predict(poly.transform(fX))
    preds = [round(max(0,min(100,float(p))),2) for p in preds]

    recent_avg = sum(vals[-5:])/5
    older_avg  = sum(vals[:5])/5
    trend = "improving" if recent_avg > older_avg+3 else \
            "declining"  if recent_avg < older_avg-3 else "stable"

    return jsonify({"predictions":preds,"steps":steps,"trend":trend,
        "confidence_r2":round(r2,4),"current_avg":round(recent_avg,2),
        "model":"Polynomial Regression (degree=2)","based_on":len(vals)})

# ══ GET /deadzones ══════════════════════════════════════════
@app.route('/deadzones')
def dead_zones():
    """GPS Dead Zone Detection via 50m grid clustering."""
    threshold = request.args.get('threshold', 35, type=int)
    conn  = get_db()
    rows  = conn.execute("""SELECT lat,lng,signal FROM signals
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY id DESC LIMIT 500""").fetchall()
    conn.close()
    if not rows:
        return jsonify({"dead_zones":[],"good_zones":[],"total_gps_points":0})

    clusters = defaultdict(list)
    for r in rows:
        key = (round(r['lat'],3), round(r['lng'],3))
        clusters[key].append(r['signal'])

    dead_zones, good_zones = [], []
    for (lat,lng), sigs in clusters.items():
        avg  = sum(sigs)/len(sigs)
        zone = {"lat":lat,"lng":lng,"avg_signal":round(avg,2),
                "readings":len(sigs),"min_signal":round(min(sigs),2),
                "max_signal":round(max(sigs),2)}
        if avg < threshold:
            zone["zone_type"] = "dead"
            zone["severity"]  = "critical" if avg < 20 else "weak"
            dead_zones.append(zone)
        else:
            zone["zone_type"] = "good"
            good_zones.append(zone)

    total = len(dead_zones)+len(good_zones)
    return jsonify({"dead_zones":dead_zones,"good_zones":good_zones,
        "total_gps_points":len(rows),"threshold":threshold,
        "dead_zone_count":len(dead_zones),
        "coverage_pct":round(len(good_zones)/(total+0.001)*100,1)})

# ══ GET /quality_score ══════════════════════════════════════
@app.route('/quality_score')
def quality_score_api():
    limit = request.args.get('limit', 50, type=int)
    conn  = get_db()
    rows  = conn.execute("""SELECT time,signal,quality_score,device_id
        FROM signals ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
    conn.close()
    data  = rows_to_dicts(rows)
    scores = [r['quality_score'] for r in data if r['quality_score']]
    avg_q  = sum(scores)/len(scores) if scores else 0
    grade  = ("Excellent" if avg_q>75 else "Good" if avg_q>55 else
              "Fair"      if avg_q>35 else "Poor")
    return jsonify({"history":data,"avg_score":round(avg_q,2),"grade":grade,
        "formula":"Signal×0.6 + Stability×0.3 + Uptime×0.1"})

# ══ GET /network_summary ════════════════════════════════════
@app.route('/network_summary')
def network_summary():
    conn  = get_db()
    by_op = conn.execute("""SELECT operator,COUNT(*) as count,
        AVG(signal) as avg_sig, AVG(quality_score) as avg_q
        FROM signals WHERE operator!='Unknown'
        GROUP BY operator ORDER BY avg_sig DESC""").fetchall()
    by_net = conn.execute("""SELECT network,COUNT(*) as count,AVG(signal) as avg_sig
        FROM signals WHERE network!='Unknown'
        GROUP BY network ORDER BY avg_sig DESC""").fetchall()
    conn.close()
    return jsonify({"by_operator":rows_to_dicts(by_op),"by_network":rows_to_dicts(by_net)})

# ══ POST /reset ═════════════════════════════════════════════
@app.route('/reset', methods=['POST'])
def reset():
    conn = get_db()
    conn.execute("DELETE FROM signals")
    conn.commit()
    conn.close()
    return jsonify({"status":"cleared"})

# ══ GET /api/docs ════════════════════════════════════════════
@app.route('/api/docs')
def api_docs():
    return render_template('api_docs.html', version=VERSION, ml=ML_AVAILABLE)

# ══ DASHBOARD ════════════════════════════════════════════════
@app.route('/')
def dashboard():
    return render_template('dashboard.html')

if __name__ == '__main__':
    print(f"\n  NetPulse v{VERSION} — http://0.0.0.0:5000\n  ML: {'✓' if ML_AVAILABLE else '✗ pip install scikit-learn numpy'}\n")
    app.run(host="0.0.0.0", port=5000, debug=True)
    import os
port = int(os.environ.get("PORT", 5000))
app.run(host="0.0.0.0", port=port, debug=False)