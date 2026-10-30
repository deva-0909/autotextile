import { useState } from 'react';
import { type Item, type Recipe, useApi } from '../api';
import { Card, StatusBadge } from '../ui';

interface Need { item_code: string; name: string; kg: number; on_hand: number; sufficient: boolean }

export default function Recipes() {
  const recipes = useApi<Recipe[]>('/recipes');
  const items = useApi<Item[]>('/inventory');
  const [calc, setCalc] = useState({ shade: '', quantity_m: '1500', width_cm: '150', gsm: '150' });
  const shade = calc.shade || recipes.data?.[0]?.shade_code || '';
  const needs = useApi<Need[]>(
    shade && `/recipes/${encodeURIComponent(shade)}/consumption?quantity_m=${calc.quantity_m}&width_cm=${calc.width_cm}&gsm=${calc.gsm}` || null,
  );
  const itemName = (code: string) => items.data?.find((i) => i.code === code)?.name ?? code;
  const fabricKg = (+calc.quantity_m * (+calc.width_cm / 100) * +calc.gsm) / 1000;

  return (
    <>
      <h1>Dye-house recipes</h1>
      <div className="grid-2">
        {recipes.data?.map((r) => (
          <Card key={r.shade_code} title={`${r.shade_code} — ${r.name}`}>
            <p className="small muted">Liquor ratio 1:{r.liquor_ratio}</p>
            <table>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.item_code}><td>{itemName(l.item_code)}</td><td className="num">{l.amount} {l.basis === 'owf' ? '% owf' : 'g/L'}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
      <Card title="Batch consumption calculator">
        <div className="form-grid">
          <label>Shade
            <select value={shade} onChange={(e) => setCalc({ ...calc, shade: e.target.value })}>
              {recipes.data?.map((r) => <option key={r.shade_code} value={r.shade_code}>{r.shade_code}</option>)}
            </select>
          </label>
          <label>Length (m)<input type="number" value={calc.quantity_m} onChange={(e) => setCalc({ ...calc, quantity_m: e.target.value })} /></label>
          <label>Width (cm)<input type="number" value={calc.width_cm} onChange={(e) => setCalc({ ...calc, width_cm: e.target.value })} /></label>
          <label>GSM<input type="number" value={calc.gsm} onChange={(e) => setCalc({ ...calc, gsm: e.target.value })} /></label>
        </div>
        <p className="small muted">Fabric weight ≈ {fabricKg.toFixed(1)} kg · dye bath ≈ {(fabricKg * (recipes.data?.find((r) => r.shade_code === shade)?.liquor_ratio ?? 0)).toFixed(0)} L</p>
        <table>
          <thead><tr><th>Item</th><th className="num">Required</th><th className="num">On hand</th><th>Stock</th></tr></thead>
          <tbody>
            {needs.data?.map((n) => (
              <tr key={n.item_code}>
                <td>{n.name}</td><td className="num">{n.kg.toFixed(2)} kg</td><td className="num">{n.on_hand.toFixed(1)} kg</td>
                <td><StatusBadge status={n.sufficient ? 'pass' : 'reject'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
