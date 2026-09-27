import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Dashboard } from './dashboard/Dashboard'
import { EditorPage } from './editor/Editor'
import { usePath } from './lib/router'
import './styles.css'

function App() {
  const path = usePath()
  const file = path.match(/^\/file\/([^/]+)/)
  return file ? <EditorPage docId={decodeURIComponent(file[1])} /> : <Dashboard />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
