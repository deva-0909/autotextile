export interface RecipeLine {
  item_code: string;
  /** owf: % on weight of fabric. gpl: grams per litre of dye bath. */
  basis: 'owf' | 'gpl';
  amount: number;
}

export interface Recipe {
  shade_code: string;
  name: string;
  liquor_ratio: number;
  lines: RecipeLine[];
}

export interface Consumption {
  item_code: string;
  kg: number;
}

export function fabricWeightKg(lengthM: number, widthCm: number, gsm: number): number {
  return (lengthM * (widthCm / 100) * gsm) / 1000;
}

/** Dyes and chemicals (kg) needed to dye one lot with this recipe. */
export function recipeConsumption(recipe: Recipe, lengthM: number, widthCm: number, gsm: number): Consumption[] {
  const fabricKg = fabricWeightKg(lengthM, widthCm, gsm);
  const liquorL = fabricKg * recipe.liquor_ratio;
  return recipe.lines.map((line) => {
    const kg = line.basis === 'owf' ? (fabricKg * line.amount) / 100 : (liquorL * line.amount) / 1000;
    return { item_code: line.item_code, kg: Math.round(kg * 1000) / 1000 };
  });
}
