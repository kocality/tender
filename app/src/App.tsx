import { Layout } from './components/Layout';
import { Keys } from './pages/Keys';
import { Sale } from './pages/Sale';
import { Try } from './pages/Try';
import { Twin } from './pages/Twin';
import { useHashRoute } from './router';

function ComingSoon({ title }: { title: string }) {
  return (
    <div>
      <h1>{title}</h1>
      <p className="muted">This screen is not built yet.</p>
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  let page;
  switch (route.path) {
    case '/':
      page = <Twin />;
      break;
    case '/sale/:id':
      page = <Sale id={route.params.id ?? ''} />;
      break;
    case '/bid/:id':
      page = <ComingSoon title={`Bid on sale #${route.params.id ?? ''}`} />;
      break;
    case '/try':
      page = <Try />;
      break;
    case '/keys':
      page = <Keys />;
      break;
    case '/withdraw':
      page = <ComingSoon title="Withdraw to chain" />;
      break;
    default:
      page = (
        <div>
          <h1>Not found</h1>
          <p>
            <a href="#/">Back to the twin sales</a>
          </p>
        </div>
      );
  }
  return <Layout current={route.path}>{page}</Layout>;
}
