import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { ToastProvider } from './components/common/Toast';

function App() {
  return (
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  );
}

export default App;
