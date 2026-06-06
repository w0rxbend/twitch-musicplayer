import { render } from 'solid-js/web';
import { AdminApp } from './AdminApp';
import './styles/admin.css';

render(() => <AdminApp />, document.getElementById('admin-root')!);
