<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import DefaultLayout from './layouts/DefaultLayout.vue'

const route = useRoute()
const usesAdminLayout = computed(() => route.meta.layout === 'admin')
</script>

<template>
  <RouterView v-if="usesAdminLayout" />
  <DefaultLayout v-else />
</template>
