/* tslint:disable import-name */
import http, { RequestListener } from 'http';
import axios, { AxiosInstance } from 'axios';
import isString from 'lodash.isstring';
import isRegExp from 'lodash.isregexp';
import isFunction from 'lodash.isfunction';
import isPlainObject from 'lodash.isplainobject';
import debugFactory from 'debug';
import { ErrorCode, CodedError } from './errors';
import { createHTTPHandler } from './http-handler';
import { packageIdentifier, promiseTimeout, isFalsy } from './util';
import { RequestHandler } from 'express'; // tslint:disable-line no-implicit-dependencies - only a type is imported
/* tslint:enable import-name */

const debug = debugFactory('@slack/interactive-messages:adapter');

/**
 * Transforms various forms of matching constraints to a single standard object shape
 * @param matchingConstraints - the various forms of matching constraints accepted
 * @returns an object where each matching constraint is a property
 */
function formatMatchingConstraints<C extends AnyConstraints>(matchingConstraints: string | RegExp | C): C {
  if (matchingConstraints === undefined || matchingConstraints === null) {
    throw new TypeError('Constraints cannot be undefined or null');
  }

  let ret: AnyConstraints = {};
  if (!isPlainObject(matchingConstraints)) {
    ret.callbackId = matchingConstraints as string | RegExp;
  } else {
    ret = Object.assign({}, matchingConstraints as C);
  }
  return ret as C;
}

/**
 * Validates general properties of a matching constraints object
 * @param matchingConstraints - object describing the constraints on a callback
 * @returns `false` represents successful validation, an error represents failure and describes why validation failed.
 */
function validateConstraints(matchingConstraints: AnyConstraints): Error | false {
  if (!isFalsy(matchingConstraints.callbackId) &&
      !(isString(matchingConstraints.callbackId) || isRegExp(matchingConstraints.callbackId))) {
    return new TypeError('Callback ID must be a string or RegExp');
  }

  if (!isFalsy(matchingConstraints.blockId) &&
    !(isString(matchingConstraints.blockId) || isRegExp(matchingConstraints.blockId))) {
    return new TypeError('Block ID must be a string or RegExp');
  }

  if (!isFalsy(matchingConstraints.actionId) &&
    !(isString(matchingConstraints.actionId) || isRegExp(matchingConstraints.actionId))) {
    return new TypeError('Action ID must be a string or RegExp');
  }

  return false;
}

/**
 * Validates properties of a matching constraints object specific to registering an options request
 * @param matchingConstraints - object describing the constraints on an options handler
 * @returns `false` represents successful validation, an error represents failure and describes why validation failed.
 */
function validateOptionsConstraints(optionsConstraints: OptionsConstraints): Error | false {
  if (!isFalsy(optionsConstraints.within) &&
    !(optionsConstraints.within === 'interactive_message' ||
      optionsConstraints.within === 'block_actions' ||
      optionsConstraints.within === 'dialog')
  ) {
    return new TypeError('Within must be \'block_actions\', \'interactive_message\' or \'dialog\'');
  }

  // We don't need to validate unfurl, we'll just cooerce it to a boolean
  return false;
}

/**
 * An adapter for Slack's interactive message components such as buttons, menus, and dialogs.
 * @typicalname slackInteractions
 */
export class SlackMessageAdapter {
  /**
   * Slack app signing secret used to authenticate request
   */
  public signingSecret: string;

  /**
   * The number of milliseconds to wait before flushing a syncrhonous response to an incoming request and falling back
   * to an asynchronous response.
   */
  public syncResponseTimeout: number;

  /**
   * Whether or not promises that resolve after the syncResponseTimeout can fallback to a request for the response_url.
   * This only works in cases where the semantic meaning of the response and the response_url are the same.
   */
  public lateResponseFallbackEnabled: boolean;

  private callbacks: [StoredConstraints, Callback][];
  private axios: AxiosInstance;
  private server?: http.Server;

  /**
   * Create a message adapter.
   *
   * @param signingSecret - Slack app signing secret used to authenticate request
   * @param options.syncResponseTimeout - number of milliseconds to wait before flushing a syncrhonous response to an
   *   incoming request and falling back to an asynchronous response.
   * @param options.lateResponseFallbackEnabled - whether or not promises that resolve after the syncResponseTimeout can
   *   fallback to a request for the response_url. this only works in cases where the semantic meaning of the response
   *   and the response_url are the same.
   */
  constructor(signingSecret: string, {
    syncResponseTimeout = 2500,
    lateResponseFallbackEnabled = true,
  }: MessageAdapterOptions = {}) {
    if (!isString(signingSecret)) {
      throw new TypeError('SlackMessageAdapter needs a signing secret');
    }

    if (syncResponseTimeout > 3000 || syncResponseTimeout < 1) {
      throw new TypeError('syncResponseTimeout must be between 1 and 3000');
    }

    this.signingSecret = signingSecret;
    this.syncResponseTimeout = syncResponseTimeout;
    this.lateResponseFallbackEnabled = lateResponseFallbackEnabled;
    this.callbacks = [];
    this.axios = axios.create({
      headers: {
        'User-Agent': packageIdentifier(),
      },
    });

    debug('instantiated');
  }

  /* Interface for using the built-in server */

  /**
   * Create a server that dispatches Slack's interactive message actions and menu requests to this message adapter
   * instance. Use this method if your application will handle starting the server.
   *
   * @returns A promise that resolves to an instance of http.Server and will dispatch interactive message actions and
   *   options requests to this message adapter instance. See
   *   https://nodejs.org/dist/latest/docs/api/http.html#http_class_http_server
   */
  public async createServer(): Promise<http.Server> {
    // TODO: more options (like https)
    return http.createServer(this.requestListener());
  }

  /**
   * Start a built-in server that dispatches Slack's interactive message actions and menu requests to this message
   * adapter interface.
   *
   * @returns A promise that resolves once the server is ready
   */
  public start(port: number): Promise<http.Server> {
    return this.createServer()
      .then(server => new Promise((resolve, reject) => {
        this.server = server;
        server.on('error', reject);
        server.listen(port, () => resolve(server));
        debug('server started - port: %s', port);
      }));
  }

  /**
   * Stop the previously started built-in server.
   *
   * @returns A promise that resolves once the server is cleaned up.
   */
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!isFalsy(this.server)) {
        this.server.close((error) => {
          delete this.server;
          if (!isFalsy(error)) {
            reject(error);
          } else {
            resolve();
          }
        });
      } else {
        reject(new Error('SlackMessageAdapter cannot stop when it did not start a server'));
      }
    });
  }

  /* Interface for bringing your own server */

  /**
   * Create a middleware function that can be used to integrate with the `express` web framework in order for incoming
   * requests to be dispatched to this message adapter instance.
   *
   * @returns A middleware function (see http://expressjs.com/en/guide/using-middleware.html)
   */
  public expressMiddleware(): RequestHandler {
    const requestListener = this.requestListener();
    return (req, res, _next) => {
      requestListener(req, res);
    };
  }

  /**
   * Create a request listener function that handles HTTP requests, verifies requests and dispatches responses
   */
  public requestListener(): RequestListener {
    return createHTTPHandler(this);
  }

  /* Interface for adding handlers */

  /* tslint:disable max-line-length */
  /**
   * Add a handler for an interactive message action.
   *
   * Usually there's no need to be concerned with _how_ a message is sent to Slack, but the following table describes it
   * fully.
   *
   * **Action**|**Return `object`**|**Return `Promise<object>`**|**Return `undefined`**|**Call `respond(message)`**|**Notes**
   * :-----:|:-----:|:-----:|:-----:|:-----:|:-----:
   * **Button Press**| Message in response | When resolved before `syncResposeTimeout` or `lateResponseFallbackEnabled: false`, message in response<br />When resolved after `syncResponseTimeout` and `lateResponseFallbackEnabled: true`, message in request to `response_url` | Empty response | Message in request to `response_url` | Create a new message instead of replacing using `replace_original: false`
   * **Menu Selection**| Message in response | When resolved before `syncResposeTimeout` or `lateResponseFallbackEnabled: false`, message in response<br />When resolved after `syncResponseTimeout` and `lateResponseFallbackEnabled: true`, message in request to `response_url` | Empty response | Message in request to `response_url` | Create a new message instead of replacing using `replace_original: false`
   * **Message Action** | Message in response | When resolved before `syncResposeTimeout` or `lateResponseFallbackEnabled: false`, message in response<br />When resolved after `syncResponseTimeout` and `lateResponseFallbackEnabled: true`, message in request to `response_url` | Empty response | Message in request to `response_url` |
   * **Dialog Submission**| Error list in response | Error list in response | Empty response | Message in request to `response_url` | Returning a Promise that takes longer than 3 seconds to resolve can result in the user seeing an error. Warning logged if a promise isn't completed before `syncResponseTimeout`.
   *
   * @param matchingConstraints - the callback ID (as a string or RegExp) or an object describing the constraints to
   *   match actions for the handler.
   * @param callback - the function to run when an action is matched
   * @returns this instance (for chaining)
   */
  /* tslint:enable max-line-length */
  public action(
    matchingConstraints: string | RegExp | ActionConstraints,
    callback: ActionHandler,
  ): this {
    const actionConstraints = formatMatchingConstraints(matchingConstraints);
    const error = validateConstraints(actionConstraints);
    if (error) {
      debug('action could not be registered: %s', error.message);
      throw error;
    }

    const storableConstraints = Object.assign(actionConstraints, {
      handlerType: StoredConstraintsType.Action as const,
    });
    return this.registerCallback(storableConstraints, callback);
  }

  /* tslint:disable max-line-length */
  /**
   * Add a handler for an options request
   *
   * Usually there's no need to be concerned with _how_ a message is sent to Slack, but the
   * following table describes it fully
   *
   * &nbsp;|**Return `options`**|**Return `Promise<options>`**|**Return `undefined`**|**Notes**
   * :-----:|:-----:|:-----:|:-----:|:-----:
   * **Options Request**| Options in response | Options in response | Empty response | Returning a Promise that takes longer than 3 seconds to resolve can result in the user seeing an error. If the request is from within a dialog, the `text` field is called `label`.
   *
   * @param matchingConstraints - the callback ID (as a string or RegExp) or an object describing the constraints to
   *   select options requests for the handler.
   * @param callback - the function to run when an options request is matched
   * @returns this instance (for chaining)
   */
  /* tslint:enable max-line-length */
  public options(
    matchingConstraints: string | RegExp | OptionsConstraints,
    callback: OptionsHandler,
  ): this {
    const optionsConstraints = formatMatchingConstraints(matchingConstraints);
    const error = validateConstraints(optionsConstraints) ||
      validateOptionsConstraints(optionsConstraints);
    if (error) {
      debug('options could not be registered: %s', error.message);
      throw error;
    }

    const storableConstraints = Object.assign(optionsConstraints, {
      handlerType: StoredConstraintsType.Options as const,
    });
    return this.registerCallback(storableConstraints, callback);
  }

  /* Interface for HTTP servers (like express middleware) */

  /**
   * Dispatches the contents of an HTTP request to the registered handlers.
   *
   * @remarks
   * This is an internal API not meant to be used by code depending on this package.
   *
   * @internal
   * @returns A promise of the response information (an object with status and content that is a JSON serializable
   *   object or a string or undefined) for the request. An undefined return value indicates that the request was not
   *   matched.
   */
  public dispatch(payload: any): Promise<DispatchResult> | undefined {
    const callback = this.matchCallback(payload);
    if (isFalsy(callback)) {
      debug('dispatch could not find a handler');
      return undefined;
    }
    debug('dispatching to handler');
    const [, callbackFn] = callback;

    // when a response_url is present,`respond()` function created to to send a message using it
    const respond: Respond | undefined = payload.response_url ? (message: any): Promise<any> => {
      if (typeof (message as any).then === 'function') {
        throw new TypeError('Cannot use a Promise as the parameter for respond()');
      }
      debug('sending async response');
      return this.axios.post(payload.response_url, message);
    } : undefined;

    let callbackResult: any;
    try {
      callbackResult = callbackFn.call(this, payload, respond as Respond);
    } catch (error) {
      debug('callback error: %o', error);
      return Promise.resolve({ status: ResponseStatus.Failure });
    }

    if (!isFalsy(callbackResult)) {
      return promiseTimeout(this.syncResponseTimeout, callbackResult)
        .then(content => ({ content, status: ResponseStatus.Ok }))
        .catch<DispatchResult>((error: CodedError) => {
          if (error.code === ErrorCode.PromiseTimeout) {
            // warn and continue for promises that cannot be saved with a later async response.
            // this includes dialog submissions because the response_url doesn't have the same
            // semantics as the response, any request that doesn't contain a response_url, and
            // if this has been explicitly disabled in the configuration.
            if (!this.lateResponseFallbackEnabled || respond === undefined || payload.type === 'dialog_submission') {
              debug('WARNING: The response Promise did not resolve under the timeout.');
              return (callbackResult as Promise<any>)
                .then(content => ({ content, status: ResponseStatus.Ok }))
                .catch(() => ({ status: ResponseStatus.Failure }));
            }

            // save a late promise by sending an empty body in the response, and then use the
            // response_url to send the eventually resolved value
            (callbackResult as Promise<any>).then(respond).catch((callbackError) => {
              // when the promise is late and fails, we cannot do anything but log it
              debug('ERROR: Promise was late and failed. Use `.catch()` to handle errors.');
              throw callbackError;
            });
            return { status: ResponseStatus.Ok };
          }

          return { status: ResponseStatus.Failure };
        });
    }

    // The following result value represents:
    // * "no replacement" for message actions
    // * "submission is valid" for dialog submissions
    // * "no suggestions" for menu options TODO: check that this is true
    return Promise.resolve({ status: 200 });
  }

  private registerCallback(constraints: StoredConstraints, callback: Callback): this {
    // Validation
    if (!isFunction(callback)) {
      debug('did not register callback because its not a function');
      throw new TypeError('callback must be a function');
    }

    this.callbacks.push([constraints, callback]);

    return this;
  }

  private matchCallback(payload: any): [StoredConstraints, Callback] | undefined {
    return this.callbacks.find(([constraints]) => {
      // if the callback ID constraint is specified, only continue if it matches
      if (!isFalsy(constraints.callbackId)) {
        if (isString(constraints.callbackId) && payload.callback_id !== constraints.callbackId) {
          return false;
        }
        if (isRegExp(constraints.callbackId) && !(constraints.callbackId as RegExp).test(payload.callback_id)) {
          return false;
        }
      }

      // if the action constraint is specified, only continue if it matches
      if (constraints.handlerType === StoredConstraintsType.Action) {
        // a payload that represents an action either has actions, submission, or message defined
        // PATCH: The view_submission action type for responding to modal submissions
        // fails this check. Allow payload.view to let this action through fixes this.
        // https://github.com/slackapi/node-slack-sdk/pull/874
        if (!(payload.actions || payload.submission || payload.message || payload.view)) {
          return false;
        }

        // dialog submissions don't have an action defined, so an empty action is substituted for
        // the purpose of callback matching
        const action = payload.actions ? payload.actions[0] : {};

        // if the block ID constraint is specified, only continue if it matches
        if (!isFalsy(constraints.blockId)) {
          if (isString(constraints.blockId) && action.block_id !== constraints.blockId) {
            return false;
          }
          if (isRegExp(constraints.blockId) && !(constraints.blockId as RegExp).test(action.block_id)) {
            return false;
          }
        }

        // if the action ID constraint is specified, only continue if it matches
        if (!isFalsy(constraints.actionId)) {
          if (isString(constraints.actionId) && action.action_id !== constraints.actionId) {
            return false;
          }
          if (isRegExp(constraints.actionId) && !(constraints.actionId as RegExp).test(action.action_id)) {
            return false;
          }
        }

        // button and message actions have a type defined inside the action, dialog submission
        // actions have a type defined at the top level, and select actions don't have a type
        // defined, but type can be inferred by checking if a `selected_options` property exists in
        // the action.
        // tslint:disable-next-line strict-boolean-expressions
        const type = action.type || payload.type || (action.selected_options && 'select');
        if (!type) {
          debug('no type found in dispatched action');
        }
        // if the type constraint is specified, only continue if it matches
        if (!isFalsy(constraints.type) && constraints.type !== type) {
          return false;
        }

        // if the unfurl constraint is specified, only continue if it matches
        if ('unfurl' in constraints &&
          (
            (constraints.unfurl && !payload.is_app_unfurl) ||
            (!constraints.unfurl && payload.is_app_unfurl)
          )
        ) {
          return false;
        }
      }

      if (constraints.handlerType === StoredConstraintsType.Options) {
        // a payload that represents an options request in attachments always has a name defined
        // at the top level. in blocks the type is block_suggestion and has no name
        if (!('name' in payload || (payload.type && payload.type === 'block_suggestion'))) {
          return false;
        }

        // if the block ID constraint is specified, only continue if it matches
        if (!isFalsy(constraints.blockId)) {
          if (isString(constraints.blockId) && payload.block_id !== constraints.blockId) {
            return false;
          }
          if (isRegExp(constraints.blockId) && !(constraints.blockId as RegExp).test(payload.block_id)) {
            return false;
          }
        }

        // if the action ID constraint is specified, only continue if it matches
        if (!isFalsy(constraints.actionId)) {
          if (isString(constraints.actionId) && payload.action_id !== constraints.actionId) {
            return false;
          }
          if (isRegExp(constraints.actionId) && !(constraints.actionId as RegExp).test(payload.action_id)) {
            return false;
          }
        }

        // an options request always has a type at the top level which can be one of three values
        // that need to be mapped into the values for the `within` constraint:
        // * type:interactive_message => within:interactive_message
        // * type:block_suggestion => within:block_actions
        // * type:dialog_suggestion => within:dialog
        if (!isFalsy(constraints.within)) {
          if (constraints.within === 'interactive_message' && payload.type !== 'interactive_message') {
            return false;
          }
          if (constraints.within === 'block_actions' && payload.type !== 'block_suggestion') {
            return false;
          }
          if (constraints.within === 'dialog' && payload.type !== 'dialog_suggestion') {
            return false;
          }
        }
      }

      // if there's no reason to eliminate this callback, then its a match!
      return true;
    });
  }
}

export default SlackMessageAdapter;

/** Some HTTP response statuses. */
enum ResponseStatus {
  Ok = 200,
  Failure = 500,
}

/**
 * The result of a call to {@link SlackMessageAdapter#dispatch}.
 */
interface DispatchResult {
  status: ResponseStatus;
  content?: any;
}

/**
 * Options for constructing {@link SlackMessageAdapter}.
 */
export interface MessageAdapterOptions {
  syncResponseTimeout?: number;
  lateResponseFallbackEnabled?: boolean;
}

/**
 * Constraints on when to call an action handler.
 */
export interface ActionConstraints {
  /**
   * A string or RegExp to match against the `callback_id`
   */
  callbackId?: string | RegExp;

  /**
   * A string or RegExp to match against the `block_id`
   */
  blockId?: string | RegExp;

  /**
   * A string or RegExp to match against the `action_id`
   */
  actionId?: string | RegExp;

  /**
   * Valid types include all
   * [actions block elements](https://api.slack.com/reference/messaging/interactive-components),
   * `select` only for menu selections, or `dialog_submission` only for dialog submissions
   */
  type?: string;

  /**
   * When `true` only match actions from an unfurl
   */
  unfurl?: boolean;
}

/**
 * Constraints on when to call an options handler.
 */
export interface OptionsConstraints {
  /**
   * A string or RegExp to match against the `callback_id`
   */
  callbackId?: string | RegExp;

  /**
   * A string or RegExp to match against the `block_id`
   */
  blockId?: string | RegExp;

  /**
   * A string or RegExp to match against the `action_id`
   */
  actionId?: string | RegExp;

  /**
   * The source of options request.
   */
  within: 'block_actions' | 'interactive_message' | 'dialog';
}

type AnyConstraints = ActionConstraints | OptionsConstraints;

/**
 * The type of stored constraints.
 */
const enum StoredConstraintsType {
  Action = 'action',
  Options = 'options',
}

/**
 * Internal storage type that describes the constraints of an ActionHandler or OptionsHandler.
 */
type StoredConstraints =
 | ({ handlerType: StoredConstraintsType.Action } & ActionConstraints)
 | ({ handlerType: StoredConstraintsType.Options } & OptionsConstraints);

/**
 * A function used to send message updates after an action is handled. This function can be used
 * up to 5 times in 30 minutes.
 *
 * @param message - a [message](https://api.slack.com/docs/interactive-message-field-guide#top-level_message_fields).
 *   Dialog submissions do not allow `replace_original: false` on this message.
 * @returns there's no contract or interface for the resolution value, but this Promise will resolve when the HTTP
 *   response from the `response_url` request is complete and reject when there is an error.
 */
type Respond = (message: any) => Promise<unknown>;

/**
 * A handler function for action requests (block actions, button presses, menu selections,
 * and dialog submissions).
 *
 * @param payload - an object describing the
 *   [block actions](https://api.slack.com/messaging/interactivity/enabling#understanding-payloads)
 *   [button press](https://api.slack.com/docs/message-buttons#responding_to_message_actions),
 *   [menu selection](https://api.slack.com/docs/message-menus#request_url_response), or
 *   [dialog submission](https://api.slack.com/dialogs#evaluating_submission_responses).
 * @param respond - When the action is a button press or menu selection, this function is used to update the message
 *   where the action occurred or create new messages in the same conversation. When the action is a dialog submission,
 *   this function is used to create new messages in the conversation where the dialog was triggered.
 * @returns When the action is a button press or a menu selection, this object is a replacement
 *   [message](https://api.slack.com/docs/interactive-message-field-guide#top-level_message_fields) for the message in
 *   which the action occurred. It may also be a Promise for a message, and if so and the Promise takes longer than the
 *   `syncResponseTimeout` to complete, the message is sent over the `response_url`. The message may also be a new
 *   message in the same conversation by setting `replace_original: false`. When the action is a dialog submission,
 *   this object is a list of [validation errors](https://api.slack.com/dialogs#input_validation). It may also be a
 *   Promise for a list of validation errors, and if so and the Promise takes longer than the `syncReponseTimeout` to
 *   complete, Slack will display an error to the user. If there is no return value, then button presses and menu
 *   selections do not update the message and dialog submissions will validate and dismiss.
 */
type ActionHandler = (payload: any, respond: Respond) => any | Promise<any> | undefined;

/**
 * A handler function for menu options requests.
 *
 * @param payload - an object describing
 *   [the state of the menu](https://api.slack.com/docs/message-menus#options_load_url)
 * @returns an [options list](https://api.slack.com/docs/interactive-message-field-guide#option_fields) or
 *   [option groups list](https://api.slack.com/docs/interactive-message-field-guide#option_groups). When the menu is
 *   within an interactive message, (`within: 'interactive_message'`) the option keys are `text` and `value`. When the
 *   menu is within a dialog (`within: 'dialog'`) the option keys are `label` and `value`. When the menu is within a
 *   dialog (`within: 'block_actions'`) the option keys are a text block and `value`. This function may also return a
 *   Promise either of these values. If a Promise is returned and it does not complete within 3 seconds, Slack will
 *   display an error to the user. If there is no return value, then the user is shown an empty list of options.
 */
type OptionsHandler = (payload: any) => any | Promise<any> | undefined;

type Callback = ActionHandler | OptionsHandler;
