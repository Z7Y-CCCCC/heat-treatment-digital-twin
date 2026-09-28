<script setup>
import { onMounted, ref } from 'vue'
import FactoryDirectorySettings from './FactoryDirectorySettings.vue'

const provinces = ref([])
const countries = ref([])

onMounted(async () => {
  try {
    const [china, world] = await Promise.all([
      fetch('/maps/china-provinces.geojson').then(response => response.json()),
      fetch('/maps/world-countries.geojson').then(response => response.json())
    ])
    provinces.value = china.features.filter(feature => feature.properties.adcode)
      .map(feature => ({ id: String(feature.properties.adcode), name: feature.properties.name }))
    countries.value = world.features.map(feature => ({
      id: feature.properties.ADM0_A3,
      isoA2: /^[A-Z]{2}$/.test(feature.properties.ISO_A2 || '') ? feature.properties.ISO_A2 : feature.properties.ISO_A2_EH,
      name: feature.properties.NAME_ZH || feature.properties.ADMIN
    })).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  } catch {
    // The registry remains usable when the optional geographic catalog is offline.
  }
})
</script>

<template>
  <FactoryDirectorySettings :provinces="provinces" :countries="countries" />
</template>
