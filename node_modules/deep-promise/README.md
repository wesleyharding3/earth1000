# deep-promise

Yet another small, simple but powerfull promise lib __including concurrent context management__.

It has been written when really few js promise libraries was there, and has been heavily used and binded in deepjs core.

It is now extracted from deepjs and avaiable as stand-alone library.

Historicaly, it provides concept that __is not__ in Promise A+ standard, and for few divergent points it could be one day rewritten to include Promise A+ standards.

The main difference, is that deep-promise include __concurrent context management pattern__ that comes from `future` (the very first name of promise in the 80's) and that is one of the powerful gem hidden in Promise patterns that you should absolutly know.

## API

### Base

#### .when

#### .then

#### .done 

#### .fail/.catch 

#### new Promise

### Concurrent context

### Logger

### State

### Custom API

### Identities

### Deferred

### Promisify

## Tests

### Under nodejs

You need to have mocha installed globally before launching test. 
```
> npm install -g mocha
```
Do not forget to install dev-dependencies from 'decompose' folder :
```
> npm install
```

then, always in 'decompose' folder simply enter :
```
> mocha
```

### In the browser

Simply serve ./test folder in you favorite web server then open ./test/index.html.

You could use the provided "gulp web server" by entering :
```
> gulp serve-test
```

## Licence

The [MIT](http://opensource.org/licenses/MIT) License

Copyright (c) 2015 Gilles Coomans <gilles.coomans@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.