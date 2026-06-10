#!/usr/bin/env python3
"""AI Infra Price Index collector.

Fetches live GPU/CPU/RAM prices from RunPod, Vast.ai and ec2.shop (stdlib
only) and appends a snapshot to web/data/history.json.
"""
import json
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TIMEOUT = 20
USER_AGENT = "infra-index-collector/1.0"
HISTORY_PATH = Path(__file__).resolve().parent.parent / "web" / "data" / "history.json"

# canonical key -> (runpod displayName, [vast gpu_name candidates])
GPU_BASKET = {
    "H100 SXM": ("H100 SXM", ["H100 SXM"]),
    "H100 PCIe": ("H100 PCIe", ["H100 PCIE", "H100 PCIe"]),
    "A100 80GB SXM": ("A100 SXM", ["A100 SXM4"]),
    "RTX 4090": ("RTX 4090", ["RTX 4090"]),
    "L40S": ("L40S", ["L40S"]),
    "B200": ("B200", ["B200"]),
}


def warn(msg):
    print(f"WARNING: {msg}", file=sys.stderr)


def http_json(url, data=None, headers=None):
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_runpod():
    """Return {displayName: {"secure": x, "community": y}} with 0/null dropped."""
    query = "query { gpuTypes { id displayName memoryInGb securePrice communityPrice } }"
    body = json.dumps({"query": query}).encode("utf-8")
    data = http_json("https://api.runpod.io/graphql", data=body,
                     headers={"Content-Type": "application/json"})
    out = {}
    for gpu in data["data"]["gpuTypes"]:
        entry = {}
        if gpu.get("securePrice"):
            entry["secure"] = gpu["securePrice"]
        if gpu.get("communityPrice"):
            entry["community"] = gpu["communityPrice"]
        if entry:
            out[gpu["displayName"]] = entry
    return out


def fetch_vast_median(gpu_name):
    """Median per-GPU $/hr over verified rentable on-demand offers, or None."""
    q = json.dumps({
        "verified": {"eq": True}, "rentable": {"eq": True},
        "gpu_name": {"eq": gpu_name}, "limit": 100,
        "order": [["dph_total", "asc"]], "type": "on-demand",
    })
    url = "https://console.vast.ai/api/v0/bundles/?" + urllib.parse.urlencode({"q": q})
    offers = http_json(url).get("offers", [])
    prices = [o["dph_total"] / o["num_gpus"]
              for o in offers if o.get("dph_total") and o.get("num_gpus")]
    return statistics.median(prices) if prices else None


def fetch_ec2():
    """Return (cpu_per_vcpu_hr, ram_per_gb_hr) from c7i/r7i.2xlarge prices."""
    data = http_json("https://ec2.shop?filter=c7i.2xlarge,r7i.2xlarge")
    cost = {p["InstanceType"]: p["Cost"] for p in data["Prices"]}
    c, r = cost["c7i.2xlarge"], cost["r7i.2xlarge"]
    ram = (r - c) / 48
    cpu = (c - 16 * ram) / 8
    return cpu, ram


def geometric_mean(values):
    prod = 1.0
    for v in values:
        prod *= v
    return prod ** (1.0 / len(values))


def compute_indices(snapshot, baseline):
    """Indices vs baseline snapshot; the baseline itself scores 100 everywhere."""
    indices = {}
    ratios = []
    for model, prices in snapshot["gpu"].items():
        base = baseline["gpu"].get(model, {})
        if prices.get("best") and base.get("best"):
            ratios.append(prices["best"] / base["best"])
    indices["gpu"] = 100 * geometric_mean(ratios) if ratios else None
    for key, field in (("cpu", "cpu_per_vcpu_hr"), ("ram", "ram_per_gb_hr")):
        cur, base = snapshot.get(field), baseline.get(field)
        indices[key] = 100 * cur / base if cur and base else None
    if all(indices.get(k) for k in ("gpu", "cpu", "ram")):
        indices["composite"] = 100 * ((indices["gpu"] / 100) ** 0.6 *
                                      (indices["cpu"] / 100) ** 0.2 *
                                      (indices["ram"] / 100) ** 0.2)
    else:
        indices["composite"] = None
    return {k: round(v, 2) if v is not None else None
            for k, v in (("composite", indices["composite"]), ("gpu", indices["gpu"]),
                         ("cpu", indices["cpu"]), ("ram", indices["ram"]))}


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot = {"ts": now, "gpu": {}}

    try:
        runpod = fetch_runpod()
    except Exception as e:
        warn(f"RunPod fetch failed: {e}")
        runpod = {}

    for model, (rp_name, vast_names) in GPU_BASKET.items():
        entry = {}
        rp = runpod.get(rp_name, {})
        if "secure" in rp:
            entry["runpod_secure"] = round(rp["secure"], 4)
        if "community" in rp:
            entry["runpod_community"] = round(rp["community"], 4)
        for vname in vast_names:
            try:
                median = fetch_vast_median(vname)
            except Exception as e:
                warn(f"Vast fetch failed for {vname!r}: {e}")
                median = None
            if median is not None:
                entry["vast_median"] = round(median, 4)
                break
        if entry:
            entry["best"] = round(min(entry.values()), 4)
            snapshot["gpu"][model] = entry
        else:
            warn(f"No price data for {model} from any source")

    try:
        cpu, ram = fetch_ec2()
        snapshot["cpu_per_vcpu_hr"] = round(cpu, 4)
        snapshot["ram_per_gb_hr"] = round(ram, 4)
    except Exception as e:
        warn(f"EC2 fetch failed: {e}")

    if HISTORY_PATH.exists():
        history = json.loads(HISTORY_PATH.read_text())
    else:
        history = {"updated": None, "snapshots": []}

    baseline = history["snapshots"][0] if history["snapshots"] else snapshot
    snapshot["indices"] = compute_indices(snapshot, baseline)

    history["snapshots"].append(snapshot)
    history["updated"] = now
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(history, indent=2) + "\n")
    print(f"Appended snapshot {now} -> {HISTORY_PATH} "
          f"({len(history['snapshots'])} snapshots, indices={snapshot['indices']})")


if __name__ == "__main__":
    main()
