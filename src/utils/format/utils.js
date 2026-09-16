"use strict";

function getType(obj) {
  return Object.prototype.toString.call(obj).slice(8, -1);
}

function formatID(id) {
  if (id != undefined && id != null) return id.replace(/(fb)?id[:.]/, "");
  else return id;
}

function padZeros(val, len) {
  val = String(val);
  len = len || 2;
  while (val.length < len) val = "0" + val;
  return val;
}

function arrayToObject(arr, getKey, getValue) {
  return arr.reduce(function (acc, val) {
    acc[getKey(val)] = getValue(val);
    return acc;
  }, {});
}

function arrToForm(form) {
  return arrayToObject(
    form,
    function (v) {
      return v.name;
    },
    function (v) {
      return v.val;
    },
  );
}

function getData_Path(Obj, Arr, Stt) {
  if (Arr.length === 0 && Obj != undefined) {
    return Obj;
  } else if (Obj == undefined) {
    return Stt;
  }
  const head = Arr[0];
  if (head == undefined) {
    return Stt;
  }
  const tail = Arr.slice(1);
  return getData_Path(Obj[head], tail, Stt++);
}

function setData_Path(obj, path, value) {
  if (!path.length) {
    return obj;
  }
  const currentKey = path[0];
  let currentObj = obj[currentKey];

  if (!currentObj) {
    obj[currentKey] = value;
    currentObj = obj[currentKey];
  }
  path.shift();
  if (!path.length) {
    currentObj = value;
  } else {
    currentObj = setData_Path(currentObj, path, value);
  }

  return obj;
}

function getPaths(obj, parentPath = []) {
  let paths = [];
  for (let prop in obj) {
    if (typeof obj[prop] === "object") {
      paths = paths.concat(getPaths(obj[prop], [...parentPath, prop]));
    } else {
      paths.push([...parentPath, prop]);
    }
  }
  return paths;
}

function cleanHTML(text) {
  text = text.replace(
    /(<br>)|(<\/?i>)|(<\/?em>)|(<\/?b>)|(!?~)|(&amp;)|(&#039;)|(&lt;)|(&gt;)|(&quot;)/g,
    (match) => {
      switch (match) {
        case "<br>":
          return "\n";
        case "<i>":
        case "<em>":
        case "</i>":
        case "</em>":
          return "*";
        case "<b>":
        case "</b>":
          return "**";
        case "~!":
        case "!~":
          return "||";
        case "&amp;":
          return "&";
        case "&#039;":
          return "'";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
      }
    },
  );
  return text;
}

function getCurrentTimestamp() {
  const date = new Date();
  const unixTime = date.getTime();
  return unixTime;
}

function getSignatureID() {
  return Math.floor(Math.random() * 2147483648).toString(16);
}

module.exports = {
  getType,
  formatID,
  padZeros,
  arrayToObject,
  arrToForm,
  getData_Path,
  setData_Path,
  getPaths,
  cleanHTML,
  getCurrentTimestamp,
  getSignatureID,
};
