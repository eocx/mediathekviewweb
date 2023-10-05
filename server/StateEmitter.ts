import { EventEmitter } from 'events';

export class StateEmitter extends EventEmitter {
  eventEmitter: any;
  state: any;

  constructor(eventEmitter) {
    super();

    this.eventEmitter = eventEmitter;
  }

  updateState(stateOrProperty, value?) {
    if (typeof stateOrProperty == 'object') {
      for (const property in stateOrProperty) {
        this.state[property] = stateOrProperty[property];
      }
    } else if (typeof stateOrProperty == 'string' && value != undefined) {
      this.state[stateOrProperty] = value;
    }
    this.emitState();
  }

  setState(stateOrProperty, value?) {
    if (typeof stateOrProperty == 'object') {
      this.state = stateOrProperty;
    } else if (typeof stateOrProperty == 'string' && value != undefined) {
      this.state = {};
      this.state[stateOrProperty] = value;
    }
    this.emitState();
  }

  emitState() {
    this.eventEmitter.emit('state', this.state);
  }
}
