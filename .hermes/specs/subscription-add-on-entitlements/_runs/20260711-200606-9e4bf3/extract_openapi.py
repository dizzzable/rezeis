import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
doc = json.loads(source.read_text(encoding="utf-8"))
paths = [
    "/api/users/{uuid}",
    "/api/users",
    "/api/hwid/devices/{userUuid}",
    "/api/hwid/devices/delete",
    "/api/hwid/devices/delete-all",
]


def deref(schema):
    seen = set()
    while isinstance(schema, dict) and "$ref" in schema and schema["$ref"] not in seen:
        ref = schema["$ref"]
        seen.add(ref)
        value = doc
        for part in ref.split("/")[1:]:
            value = value[part.replace("~1", "/").replace("~0", "~")]
        schema = value
    return schema


def shape(schema, depth=0):
    if not isinstance(schema, dict) or depth > 3:
        return None
    schema = deref(schema)
    result = {}
    for key in ("type", "format", "nullable", "enum", "required", "minimum", "maximum"):
        if key in schema:
            result[key] = schema[key]
    if "properties" in schema:
        result["properties"] = {
            key: shape(value, depth + 1) for key, value in schema["properties"].items()
        }
    if "items" in schema:
        result["items"] = shape(schema["items"], depth + 1)
    for key in ("oneOf", "anyOf", "allOf"):
        if key in schema:
            result[key] = [shape(value, depth + 1) for value in schema[key]]
    return result


for path in paths:
    print("PATH", path)
    path_item = doc.get("paths", {}).get(path)
    if path_item is None:
        print("  MISSING")
        continue
    for method, operation in path_item.items():
        if method.lower() not in {"get", "post", "patch", "delete", "put"}:
            continue
        print(" ", method.upper(), "operationId=", operation.get("operationId"))
        print(
            "   params=",
            [
                (
                    parameter.get("in"),
                    parameter.get("name"),
                    parameter.get("required"),
                    shape(parameter.get("schema", {})),
                )
                for parameter in operation.get("parameters", [])
            ],
        )
        request_body = operation.get("requestBody")
        if request_body:
            media = request_body.get("content", {}).get("application/json", {})
            print("   request=", json.dumps(shape(media.get("schema", {})), ensure_ascii=False))
        for code, response in operation.get("responses", {}).items():
            if str(code).startswith("2"):
                media = response.get("content", {}).get("application/json", {})
                print("   response", code, "=", json.dumps(shape(media.get("schema", {})), ensure_ascii=False))

relevant_fields = {
    "hwid",
    "createdAt",
    "updatedAt",
    "lastTrafficResetAt",
    "trafficLimitBytes",
    "hwidDeviceLimit",
    "trafficLimitStrategy",
    "userUuid",
    "userId",
    "requestIp",
    "expireAt",
}
for name, raw_schema in doc.get("components", {}).get("schemas", {}).items():
    schema = deref(raw_schema)
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    selected = sorted(set(properties) & relevant_fields)
    if not selected:
        continue
    print("SCHEMA", name, "required=", schema.get("required", []), "fields=", selected)
    for field in selected:
        print("  ", field, json.dumps(shape(properties[field]), ensure_ascii=False))

serialized = json.dumps(doc, ensure_ascii=False)
for needle in (
    "user.traffic_reset",
    "nextTrafficResetAt",
    "lastTrafficResetAt",
    "MONTH_ROLLING",
):
    print("STRING", needle, "count=", serialized.count(needle))
