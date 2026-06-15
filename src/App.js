import React from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import MintPlatform from './containers/MintPlatform';
import './App2.css';

function App() {
  return (
    <div className="App">
      <Router>
        <Switch>
          <Route exact path="/">
            <MintPlatform />
          </Route>
        </Switch>
      </Router>
    </div>
  );
}

export default App;
