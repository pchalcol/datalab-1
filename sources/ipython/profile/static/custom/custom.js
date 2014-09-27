/*
 * Copyright 2014 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

function overrideWebSocket() {
  // This replaces the native WebSocket functionality with one that is
  // similar in API surface area, but uses XMLHttpRequest and long-polling
  // instead... to account for server scenario that aren't WebSocket friendly.

  var READYSTATE_OPENING = 0;
  var READYSTATE_OPENED = 1;
  var READYSTATE_CLOSING = 2;
  var READYSTATE_CLOSED = 3;

  var XHR_LOADED = 4;

  function placeHolder() {
  }

  function xhr(action, data, callback) {
    callback = callback || placeHolder;

    var request = new XMLHttpRequest();
    request.open('POST', '/socket/' + action, true);
    request.onload = function() {
      if (request.readyState == XHR_LOADED) {
        request.onload = placeHolder;

        if (request.status == 200) {
          callback(null, JSON.parse(request.responseText));
        }
        else {
          callback(new Error(request.status));
        }
      }
    }

    if (data) {
      request.setRequestHeader('Content-Type', 'application/json');
      data = JSON.stringify(data);
    }
    request.send(data);
  }

  function createXHRTransport(socket) {
    var id = null;
    var polling = false;

    function send(msg) {
      xhr('send?id=' + id, { msg: msg });
    }

    function close() {
      polling = false;
      xhr('close', { socket: id });

      socket.readyState = READYSTATE_CLOSED;
      try {
        socket.onclose({ target: socket });
      }
      catch(e) {
      }
    }

    function pollTick() {
      // Issue a poll request to the server to fetch any pending events.
      // This request will not complete until either there is data, or a
      // timeout occurs.
      xhr('poll?id=' + id, null, function(e, data) {
        if (socket.readyState >= READYSTATE_CLOSING) {
          return;
        }

        if (!e) {
          var events = data.events || [];
          events.forEach(function(event) {
            switch (event.type) {
              case 'close':
                close({ target: socket });
                break;
              case 'message':
                try {
                  socket.onmessage({ target: socket, data: event.msg });
                }
                catch (e) {
                }
                break;
            }
          });
        }
        else {
          socket.onerror(new Error('Error listening to socket.'));
        }

        // Immediately queue another poll request. The net result is there
        // is always one out-going poll request per socket to the server,
        // which is completed as soon as there are events pending on the server,
        // or some timeout.
        poll();
      });
    }

    function poll() {
      if (polling) {
        // Complete current event processing and queue next poll.
        setTimeout(pollTick, 0)
      }
    }

    xhr('open?url=' + encodeURIComponent(socket._url), null, function(e, data) {
      if (!e && data.id) {
        id = data.id;
        polling = true;

        socket.readyState = READYSTATE_OPENED;
        try {
          socket.onopen({ target: socket });
        }
        catch(e) {
        }

        poll();
      }
      else {
        socket.onerror(new Error('Unable to open socket.'));
      }
    });

    return {
      send: send,
      close: close
    }
  }

  function Socket(url) {
    this._url = url;

    this.readyState = READYSTATE_OPENING;
    this._transport = createXHRTransport(this);
  }
  Socket.prototype = {
    onopen: placeHolder,
    onclose: placeHolder,
    onmessage: placeHolder,
    onerror: placeHolder,

    send: function(msg) {
      if (this.readyState != READYSTATE_OPENED) {
        throw new Error('Socket is not in opened state.');
      }

      this._transport.send(msg);
    },

    close: function() {
      if (this.readyState >= READYSTATE_CLOSING) {
        return;
      }

      this.readyState = READYSTATE_CLOSING;
      this._transport.close();
      this._transport = null;
    }
  }

  window.WebSocket = Socket;
}

if ((document.domain != 'localhost') && (document.domain != '127.0.0.1')) {
  overrideWebSocket();
}


// IPython seems to assume local persistence of notebooks - it issues an HTTP
// request to create a notebook, and on completion opens a window.
// This is fine and dandy when the round-trip time is small, but sometimes long
// enough when notebooks are remote (as they are with GCS) to trigger the popup
// blocker in browsers.
// Patch the new_notebook method to first open the window, and then navigate it
// rather than open upon completion of the operation.

IPython.NotebookList.prototype.new_notebook = function() {
  var path = this.notebook_path;
  var base_url = this.base_url;
  var notebook_window = window.open('', '_blank');

  var settings = {
    processData : false,
    cache : false,
    type : 'POST',
    dataType : 'json',
    async : false,
    success : function(data, status, xhr) {
      var notebook_name = data.name;
      url = IPython.utils.url_join_encode(base_url, 'notebooks', path, notebook_name);
      notebook_window.location.href = url;
    },
    error : $.proxy(this.new_notebook_failed, this),
  };
  var url = IPython.utils.url_join_encode(base_url, 'api/notebooks', path);
  $.ajax(url, settings);
}