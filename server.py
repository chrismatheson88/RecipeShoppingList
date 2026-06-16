import json
import os
import fcntl
import tempfile
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='.')

DATA_FILE = os.path.join(os.path.dirname(__file__), 'data.json')


def read_data():
    with open(DATA_FILE, 'r') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_SH)
        try:
            data = json.load(f)
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        return data


def write_data(data):
    fd, temp_path = tempfile.mkstemp(dir=os.path.dirname(DATA_FILE), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        os.replace(temp_path, DATA_FILE)
    except:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def capitalize_ingredient_name(name):
    cleaned = (name or '').strip()
    if not cleaned:
        return ''
    return ' '.join(part[:1].upper() + part[1:].lower() for part in cleaned.split())


def dedupe_purchase_quantities(rows):
    out = []
    seen = set()
    for row in rows or []:
        qty = str((row or {}).get('qty', '')).strip()
        unit = str((row or {}).get('unit', '')).strip()
        key = (qty, unit)
        if not qty or not unit or key in seen:
            continue
        seen.add(key)
        out.append({'qty': qty, 'unit': unit})
    return out


# ── Recipes ──────────────────────────────────────────────────────────────────

@app.route('/api/recipes', methods=['GET'])
def get_recipes():
    return jsonify(read_data()['recipes'])


@app.route('/api/recipes', methods=['PUT'])
def put_recipes():
    recipes = request.get_json()
    if not isinstance(recipes, list):
        return jsonify({'error': 'Expected a list'}), 400
    data = read_data()
    data['recipes'] = recipes
    write_data(data)
    return jsonify({'ok': True})


# ── Units ───────────────────────────────────────────────────────────────

@app.route('/api/units', methods=['GET'])
def get_units():
    return jsonify(read_data().get('customUnits', []))


@app.route('/api/units', methods=['PUT'])
def put_units():
    units = request.get_json()
    if not isinstance(units, list):
        return jsonify({'error': 'Expected a list'}), 400
    data = read_data()
    data['customUnits'] = units
    write_data(data)
    return jsonify({'ok': True})


# ── Ingredients (aggregated from all recipes) ─────────────────────────────────

@app.route('/api/ingredients', methods=['GET'])
def get_ingredients():
    """Return deduplicated ingredient list merged with any saved definitions."""
    data = read_data()
    defs = data.get('ingredientDefs', {})
    seen = {}
    for recipe in data.get('recipes', []):
        for ing in recipe.get('ingredients', []):
            name = capitalize_ingredient_name(ing.get('name', ''))
            if name:
                key = name.lower()
                if key not in seen:
                    d = defs.get(key, {})
                    seen[key] = {
                        'name': name,
                        'usedIn': [],
                        'units': d.get('units', []),
                        'purchaseQuantities': d.get('purchaseQuantities', []),
                    }
                seen[key]['usedIn'].append(recipe.get('name', ''))

    # Include ingredients that exist only in definitions (not yet used in a recipe).
    for key, d in defs.items():
        if key not in seen:
            seen[key] = {
                'name': d.get('displayName', key),
                'usedIn': [],
                'units': d.get('units', []),
                'purchaseQuantities': d.get('purchaseQuantities', []),
            }
    return jsonify(list(seen.values()))


@app.route('/api/ingredient-defs/<path:name>', methods=['PUT'])
def put_ingredient_def(name):
    """Save units and purchaseQuantities for a single ingredient (keyed by lowercase name)."""
    body = request.get_json()
    if not isinstance(body, dict):
        return jsonify({'error': 'Expected an object'}), 400
    data = read_data()
    if 'ingredientDefs' not in data:
        data['ingredientDefs'] = {}
    display_name = capitalize_ingredient_name(name)
    key = display_name.lower()
    data['ingredientDefs'][key] = {
        'displayName': display_name,
        'units': body.get('units', []),
        'purchaseQuantities': body.get('purchaseQuantities', []),
    }
    write_data(data)
    return jsonify({'ok': True})


@app.route('/api/ingredients/rename', methods=['PUT'])
def rename_ingredient():
    """Rename ingredient everywhere: defs, recipes, shopping labels."""
    body = request.get_json()
    if not isinstance(body, dict):
        return jsonify({'error': 'Expected an object'}), 400

    old_name = capitalize_ingredient_name(body.get('oldName', ''))
    new_name = capitalize_ingredient_name(body.get('newName', ''))
    if not old_name or not new_name:
        return jsonify({'error': 'oldName and newName are required'}), 400

    if old_name.lower() == new_name.lower():
        return jsonify({'ok': True})

    data = read_data()
    defs = data.setdefault('ingredientDefs', {})
    old_key = old_name.lower()
    new_key = new_name.lower()

    # Rename/merge ingredient definition.
    old_def = defs.pop(old_key, None)
    if old_def:
        if new_key in defs:
            existing = defs[new_key]
            defs[new_key] = {
                'displayName': new_name,
                'units': sorted(set((existing.get('units', []) + old_def.get('units', [])))),
                'purchaseQuantities': dedupe_purchase_quantities(
                    existing.get('purchaseQuantities', []) + old_def.get('purchaseQuantities', [])
                ),
            }
        else:
            defs[new_key] = {
                'displayName': new_name,
                'units': old_def.get('units', []),
                'purchaseQuantities': dedupe_purchase_quantities(old_def.get('purchaseQuantities', [])),
            }

    # Rename inside recipes.
    for recipe in data.get('recipes', []):
        for ing in recipe.get('ingredients', []):
            if capitalize_ingredient_name(ing.get('name', '')).lower() == old_key:
                ing['name'] = new_name

    # Rename in shopping text labels: "qty unit Ingredient Name".
    for item in data.get('shopping', []):
        text = str(item.get('text', ''))
        parts = text.split(' ', 2)
        if len(parts) == 3:
            qty, unit, ing_name = parts
            if capitalize_ingredient_name(ing_name).lower() == old_key:
                item['text'] = f"{qty} {unit} {new_name}"

    write_data(data)
    return jsonify({'ok': True})


# ── Shopping list ─────────────────────────────────────────────────────────────

@app.route('/api/shopping', methods=['GET'])
def get_shopping():
    return jsonify(read_data()['shopping'])


@app.route('/api/shopping', methods=['PUT'])
def put_shopping():
    shopping = request.get_json()
    if not isinstance(shopping, list):
        return jsonify({'error': 'Expected a list'}), 400
    data = read_data()
    data['shopping'] = shopping
    write_data(data)
    return jsonify({'ok': True})


@app.route('/api/save-data', methods=['POST'])
def save_data_endpoint():
    """Save the entire data structure to data.json."""
    body = request.get_json()
    if not isinstance(body, dict):
        return jsonify({'error': 'Expected an object'}), 400
    
    # Validate basic structure
    if 'recipes' not in body or 'ingredientDefs' not in body:
        return jsonify({'error': 'Missing required fields: recipes, ingredientDefs'}), 400
    
    try:
        write_data(body)
        return jsonify({'ok': True, 'message': 'Data saved to data.json'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Static files ──────────────────────────────────────────────────────────────

@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
