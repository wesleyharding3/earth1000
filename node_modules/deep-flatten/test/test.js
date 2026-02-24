/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */

/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */

if (typeof define !== 'function') {
	var define = require('amdefine')(module);
}
define([
	"require",
	"chai.js",
	"deep-flatten/index"
], function(require, chai, flattener) {


	var expect = chai.expect;



	describe("flatten", function() {

		describe("complex", function() {
			var bc2 = {
				test: 2
			};

			var bc = {
				test: 1
			};

			var b = {
				_backgrounds: [bc]
			};
			var res = null;

			flattener.flatten({
					_backgrounds: [bc2, b],
					c: {
						_backgrounds: [b],
						prop: 2
					},
					d: {
						_backgrounds: ["this::../c"],
					},
					e: {
						_backgrounds: ["this::/c"],
					}
				})
				.done(function(s) {
					res = s;
				});
			it("should", function() {
				expect(res.test).equals(1);
				expect(res.d.prop).equals(2);
				expect(res.e.prop).equals(2);
			});
		});
		describe("_backgrounds 1", function() {
			var a = {
				test: true
			};
			var b = {
				_backgrounds: [a]
			};
			var res = null;
			flattener.flatten(b).done(function(s) {
				res = s;
			});
			it("should", function() {
				expect(res).to.deep.equal({
					test: true
				});
			});
		});
		describe("top_transformations", function() {
			var a = {
				_transformations: [function(node) {
					node.value.hello = "world";
				}],
				lolipop: true
			};
			var b = {
				_backgrounds: [a],
				hello: "bloupi"
			};
			flattener.flatten(b);
			it("should", function() {
				expect(b.hello).equals("world");
			});
		});

		describe("foregrounds_total", function() {

			var a = {
				_backgrounds: [{
					_backgrounds: [{
						bloup: true
					}],
					backback: true,
					troulilop: "hehehehehe"
				}, {
					_foregrounds: [{
						hello: true
					}],
					forback: true
				}],
				_foregrounds: [{
					_backgrounds: [{
						biloup: true,
						_foregrounds: [{
							reu: false
						}]
					}],
					backfor: true
				}, {
					_foregrounds: [{
						lolipop: true
					}],
					forfor: true
				}],
				bazar: true,
				obj1: {
					_backgrounds: [{
						_backgrounds: [{
							bloup2: true
						}],
						backback2: true
					}, {
						_foregrounds: [{
							hello: true
						}],
						forback2: true
					}],
					_foregrounds: [{
						_backgrounds: [{
							biloup: true,
							_foregrounds: [{
								reu: false
							}]
						}],
						backfor: true
					}, {
						_foregrounds: [{
							lolipop: true
						}],
						forfor: true
					}],
					bazar: true
				},
				obj2: {
					_backgrounds: [
						"this::../obj1", {
							_backgrounds: [{
								bloup3: true
							}],
							backback3: true
						}, {
							_foregrounds: [{
								hello: "changed!!"
							}],
							forback3: true
						}
					],
					_foregrounds: [{
						_backgrounds: [{
							biloupiloup: true,
							_foregrounds: [{
								reu: "rosty"
							}]
						}],
						backfor: true
					}, {
						_foregrounds: [{
							lolipop: "telechat"
						}],
						forfor: true
					}],
					bazar: "bazari"
				}
			};
			var needed = {
				"bloup": true,
				"backback": true,
				"troulilop": "hehehehehe",
				"forback": true,
				"hello": true,
				"bazar": true,
				"obj1": {
					"bloup2": true,
					"backback2": true,
					"forback2": true,
					"hello": true,
					"bazar": true,
					"biloup": true,
					"reu": false,
					"backfor": true,
					"forfor": true,
					"lolipop": true
				},
				"obj2": {
					"bloup2": true,
					"backback2": true,
					"forback2": true,
					"hello": "changed!!",
					"bazar": "bazari",
					"biloup": true,
					"reu": "rosty",
					"backfor": true,
					"forfor": true,
					"lolipop": "telechat",
					"bloup3": true,
					"backback3": true,
					"forback3": true,
					"biloupiloup": true
				},
				"biloup": true,
				"reu": false,
				"backfor": true,
				"forfor": true,
				"lolipop": true
			};
			flattener.flatten(a);
			it("should", function() {
				expect(a).to.deep.equal(needed);
			});
		});

		describe("_transformations1", function() {
			var a = {
				_transformations: [function(node) {
					node.value.done = "hello done";
				}]
			}

			flattener.flatten(a);
			it("should", function() {
				expect(a.done).equals("hello done");
			});
		});

		describe("_transformations2", function() {
			var a = {
				_backgrounds: [{
					reu: "bloupi"
				}],
				_foregrounds: [{
					sub: {
						foo: "bar"
					}
				}],
				_transformations: [{
					"dq::.//?_type=string": function(nodes) {
						nodes.forEach(function(n) {
							n.set("lolipop")
						});
					}
				}],
				test: {
					_backgrounds: [{
						reu2: "bloupi"
					}],
					_foregrounds: [{
						sub2: {
							foo2: "bar"
						}
					}],
					_transformations: [{
						"dq::./!": function(node) {
							node.value.roo = "weeee";
						}
					}],
				}
			};
			flattener.flatten(a);
			var res = [a.reu, a.sub.foo, a.test.reu2, a.test.sub2.foo2, a.test.roo];
			it("should", function() {
				expect(JSON.stringify(res)).equals(JSON.stringify(["lolipop", "lolipop", "lolipop", "lolipop", "weeee"]));
			});
		});

		describe("_transformations3", function() {

			var a = {
				_backgrounds: [{
					b: {
						_transformations: [{
							"dq::.//?bloupi": function(nodes) {
								nodes.forEach(function(node) {
									node.value.decorated = true;
								});
							}
						}],
						c: {
							bloupi: true
						}
					}
				}]
			};

			flattener.flatten(a);

			it("should", function() {
				expect(a.b.c.decorated).equals(true);
			});
		});
	});

});