(function () {
  const STORAGE_KEY = 'recipes-app-v1';

  const DEFAULT_DATA = {
    recipes: [],
    shopping: [],
    customUnits: [],
    ingredientDefs: {},
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function capitalizeIngredientName(name) {
    const cleaned = String(name || '').trim();
    if (!cleaned) return '';
    return cleaned
      .toLowerCase()
      .split(/\s+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function dedupePurchaseQuantities(rows) {
    const seen = new Set();
    const out = [];
    (rows || []).forEach(row => {
      const qty = String((row || {}).qty || '').trim();
      const unit = String((row || {}).unit || '').trim();
      if (!qty || !unit) return;
      const key = `${qty}|${unit}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ qty, unit });
    });
    return out;
  }

  function normalizeData(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const ingredientDefs = base.ingredientDefs && typeof base.ingredientDefs === 'object'
      ? base.ingredientDefs
      : {};

    return {
      recipes: Array.isArray(base.recipes) ? base.recipes : [],
      shopping: Array.isArray(base.shopping) ? base.shopping : [],
      customUnits: Array.isArray(base.customUnits) ? base.customUnits : [],
      ingredientDefs,
    };
  }

  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeData(data)));
  }

  async function bootstrapData() {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      try {
        const parsed = normalizeData(JSON.parse(existing));
        saveData(parsed);
        return parsed;
      } catch (_) {
        // Fall through to seed from data.json/default.
      }
    }

    try {
      const response = await fetch('data.json', { cache: 'no-store' });
      if (response.ok) {
        const seeded = normalizeData(await response.json());
        saveData(seeded);
        return seeded;
      }
    } catch (_) {
      // Ignore and use empty default dataset.
    }

    saveData(DEFAULT_DATA);
    return clone(DEFAULT_DATA);
  }

  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) readyPromise = bootstrapData();
    await readyPromise;
  }

  async function getData() {
    await ensureReady();
    try {
      const parsed = normalizeData(JSON.parse(localStorage.getItem(STORAGE_KEY)));
      return clone(parsed);
    } catch (_) {
      saveData(DEFAULT_DATA);
      return clone(DEFAULT_DATA);
    }
  }

  async function updateData(mutator) {
    const data = await getData();
    mutator(data);
    saveData(data);
    return data;
  }

  async function getIngredients() {
    const data = await getData();
    const defs = data.ingredientDefs || {};
    const seen = {};

    (data.recipes || []).forEach(recipe => {
      (recipe.ingredients || []).forEach(ing => {
        const name = capitalizeIngredientName(ing.name || '');
        if (!name) return;
        const key = name.toLowerCase();
        if (!seen[key]) {
          const def = defs[key] || {};
          seen[key] = {
            name,
            usedIn: [],
            units: Array.isArray(def.units) ? def.units : [],
            purchaseQuantities: Array.isArray(def.purchaseQuantities) ? def.purchaseQuantities : [],
          };
        }
        seen[key].usedIn.push(recipe.name || '');
      });
    });

    Object.keys(defs).forEach(key => {
      if (seen[key]) return;
      const def = defs[key] || {};
      seen[key] = {
        name: def.displayName || capitalizeIngredientName(key),
        usedIn: [],
        units: Array.isArray(def.units) ? def.units : [],
        purchaseQuantities: Array.isArray(def.purchaseQuantities) ? def.purchaseQuantities : [],
      };
    });

    return Object.values(seen);
  }

  const AppStore = {
    async getRecipes() {
      return (await getData()).recipes;
    },

    async setRecipes(recipes) {
      await updateData(data => {
        data.recipes = Array.isArray(recipes) ? recipes : [];
      });
    },

    async getShopping() {
      return (await getData()).shopping;
    },

    async setShopping(shopping) {
      await updateData(data => {
        data.shopping = Array.isArray(shopping) ? shopping : [];
      });
    },

    async getUnits() {
      return (await getData()).customUnits;
    },

    async setUnits(units) {
      await updateData(data => {
        data.customUnits = Array.isArray(units) ? units : [];
      });
    },

    async getIngredients() {
      return getIngredients();
    },

    async saveIngredientDef(name, def) {
      const displayName = capitalizeIngredientName(name);
      if (!displayName) return;
      const key = displayName.toLowerCase();

      await updateData(data => {
        if (!data.ingredientDefs || typeof data.ingredientDefs !== 'object') {
          data.ingredientDefs = {};
        }
        data.ingredientDefs[key] = {
          displayName,
          units: Array.isArray(def?.units) ? def.units : [],
          purchaseQuantities: dedupePurchaseQuantities(def?.purchaseQuantities || []),
        };
      });
    },

    async renameIngredient(oldName, newName) {
      const oldDisplayName = capitalizeIngredientName(oldName);
      const newDisplayName = capitalizeIngredientName(newName);
      if (!oldDisplayName || !newDisplayName) return;
      if (oldDisplayName.toLowerCase() === newDisplayName.toLowerCase()) return;

      await updateData(data => {
        const oldKey = oldDisplayName.toLowerCase();
        const newKey = newDisplayName.toLowerCase();
        const defs = data.ingredientDefs || {};

        const oldDef = defs[oldKey];
        delete defs[oldKey];

        if (oldDef) {
          const existing = defs[newKey] || {};
          defs[newKey] = {
            displayName: newDisplayName,
            units: Array.from(new Set([...(existing.units || []), ...(oldDef.units || [])])),
            purchaseQuantities: dedupePurchaseQuantities([
              ...(existing.purchaseQuantities || []),
              ...(oldDef.purchaseQuantities || []),
            ]),
          };
        }
        data.ingredientDefs = defs;

        (data.recipes || []).forEach(recipe => {
          (recipe.ingredients || []).forEach(ing => {
            const ingredientName = capitalizeIngredientName(ing.name || '');
            if (ingredientName.toLowerCase() === oldKey) {
              ing.name = newDisplayName;
            }
          });
        });

        (data.shopping || []).forEach(item => {
          const text = String(item.text || '');
          const parts = text.split(' ', 3);
          if (parts.length < 3) return;
          const qty = parts[0];
          const unit = parts[1];
          const ingredientName = parts.slice(2).join(' ');
          if (capitalizeIngredientName(ingredientName).toLowerCase() === oldKey) {
            item.text = `${qty} ${unit} ${newDisplayName}`;
          }
        });
      });
    },

    async exportData() {
      return getData();
    },

    async importData(data) {
      saveData(normalizeData(data));
    },
  };

  window.AppStore = AppStore;
})();
