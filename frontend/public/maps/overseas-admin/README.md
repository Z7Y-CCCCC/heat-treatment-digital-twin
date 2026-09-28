Offline country/region/city dropdown data for 20 commonly configured countries.

Source: [Countries States Cities Database](https://github.com/dr5hn/countries-states-cities-database), snapshot `f3ba8b5b16635b0a39593e44f9f20a7a4f941f63`.
The source and this extracted/adapted database are available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Attribution: © Countries States Cities Database contributors.

Regenerate with `node frontend/scripts/generate-overseas-admin.mjs` from the repository root. Country JSON files are fetched only when their country is selected, so the app works offline after packaging without loading the entire catalog at startup. The source lists cities/towns, not a universal district/county hierarchy; the district field remains editable, and a location search can provide more precise coordinates.
