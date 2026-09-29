import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { LiveProvider } from './api.ts'
import { App } from './App.tsx'
import { initializeSignalsSeen } from './storage.ts'
import './styles.css'

initializeSignalsSeen()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LiveProvider>
        <App />
      </LiveProvider>
    </BrowserRouter>
  </StrictMode>,
)
