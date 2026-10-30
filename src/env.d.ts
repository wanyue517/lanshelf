/// <reference types="vite/client" />
import type { ShelfAPI } from '../shared/types'

declare global {
  interface Window {
    lanShelf: ShelfAPI
  }
}
export {}
