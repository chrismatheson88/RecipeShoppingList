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
    const seen = new Map();
    const out = [];
    (rows || []).forEach(row => {
      const qty = String((row || {}).qty || '').trim();
      const unit = String((row || {}).unit || '').trim();
      const tescoProductID = String((row || {}).tescoProductID || '').trim();
      const tescoTitle = String((row || {}).tescoTitle || '').trim();
      const tescoPrice = (row || {}).tescoPrice;
      if (!qty || !unit) return;
      const key = `${qty}|${unit}`;
      if (seen.has(key)) {
        const existingIndex = seen.get(key);
        if (!out[existingIndex].tescoProductID && tescoProductID) {
          out[existingIndex].tescoProductID = tescoProductID;
          out[existingIndex].tescoTitle = tescoTitle;
          out[existingIndex].tescoPrice = tescoPrice;
        }
        return;
      }
      seen.set(key, out.length);
      out.push({ qty, unit, tescoProductID, tescoTitle, tescoPrice });
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

  function normalizeUnit(unit) {
    const normalized = String(unit || '').trim().toLowerCase();
    const aliases = {
      g: 'grams',
      gram: 'grams',
      grams: 'grams',
      kg: 'kg',
      kilogram: 'kg',
      kilograms: 'kg',
      item: 'items',
      items: 'items',
      slice: 'slices',
      slices: 'slices',
      tsp: 'tsp',
      teaspoon: 'tsp',
      teaspoons: 'tsp',
      tbsp: 'tbsp',
      tablespoon: 'tbsp',
      tablespoons: 'tbsp',
      cup: 'cups',
      cups: 'cups',
    };
    return aliases[normalized] || normalized;
  }

  function toComparableQuantity(qty, unit) {
    const amount = parseFloat(qty);
    const normalizedUnit = normalizeUnit(unit);
    if (!Number.isFinite(amount)) return null;

    const conversions = {
      grams: { family: 'mass', factor: 1, gramEquivalent: 1 },
      kg: { family: 'mass', factor: 1000, gramEquivalent: 1000 },
      items: { family: 'count', factor: 1 },
      slices: { family: 'count', factor: 1 },
      tsp: { family: 'volume', factor: 1, gramEquivalent: 5 },
      tbsp: { family: 'volume', factor: 3, gramEquivalent: 15 },
      cups: { family: 'volume', factor: 16, gramEquivalent: 240 },
    };

    const conversion = conversions[normalizedUnit];
    if (!conversion) {
      return {
        family: `raw:${normalizedUnit}`,
        quantity: amount,
        unit: normalizedUnit,
      };
    }

    const comparable = {
      family: conversion.family,
      quantity: amount * conversion.factor,
      unit: normalizedUnit,
    };

    if (conversion.gramEquivalent && conversion.family === 'volume') {
      comparable.massEquivalent = amount * conversion.gramEquivalent;
    }

    return comparable;
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

    async calculateRecipeCost(recipe) {
      if (!recipe || !recipe.ingredients) return 0;

      const data = await getData();
      const defs = data.ingredientDefs || {};
      let totalCost = 0;

      for (const ing of recipe.ingredients) {
        if (!ing.qty || !ing.unit || !ing.name) continue;

        const ingKey = ing.name.toLowerCase();
        const def = defs[ingKey];
        if (!def || !def.purchaseQuantities || def.purchaseQuantities.length === 0) continue;

        const recipeComparable = toComparableQuantity(ing.qty, ing.unit);
        if (!recipeComparable) continue;

        let bestCostPerUnit = Infinity;

        // Find the best price per unit from available purchase quantities
        for (const pq of def.purchaseQuantities) {
          if (!pq.tescoPrice || pq.tescoPrice <= 0) continue;

          const pqComparable = toComparableQuantity(pq.qty, pq.unit);
          if (!pqComparable) continue;

          // Only compare within same family (mass, count, volume)
          if (pqComparable.family !== recipeComparable.family) {
            // Try mass equivalent for volume-to-mass conversion
            if (recipeComparable.family === 'mass' && pqComparable.massEquivalent) {
              const costPerGram = pq.tescoPrice / pqComparable.massEquivalent;
              bestCostPerUnit = Math.min(bestCostPerUnit, costPerGram);
            }
            continue;
          }

          const costPerUnit = pq.tescoPrice / pqComparable.quantity;
          bestCostPerUnit = Math.min(bestCostPerUnit, costPerUnit);
        }

        if (isFinite(bestCostPerUnit)) {
          const ingredientCost = recipeComparable.quantity * bestCostPerUnit;
          totalCost += ingredientCost;
        }
      }

      return totalCost;
    },
  };

  window.AppStore = AppStore;
})();
