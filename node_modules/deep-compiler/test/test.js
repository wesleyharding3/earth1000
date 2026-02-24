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
	"deep-compiler/index",
	"deep-compiler/lib/classes",
	"deep-compiler/lib/collider",
	"deep-compiler/lib/restrictions"
], function(require, chai, compiler, Classes, collider, restrictions) {

	var expect = chai.expect;

	describe("compiler", function() {
		describe("up", function() {

			var a = {
				steps: [{
					id: "client",
					label: "hello"
				}]
			};
			var b = {
				steps: [{
					id: "address",
					label: "heu"
				}, {
					id: "client",
					label: "world",
					testez: 1
				}]
			};
			compiler.up(a, b);
			it("should", function() {
				expect(JSON.stringify(a)).to.equal(JSON.stringify({
					"steps": [{
						"id": "client",
						"label": "world",
						"testez": 1
					}, {
						"id": "address",
						"label": "heu"
					}]
				}));
			});
		});
		describe("bottom_object", function() {
			var r = compiler.abottom({
				"a": {
					"second": true
				}
			}, {
				"a": {
					"hello": "world"
				}
			});
			it("should", function() {
				expect(r.a).to.deep.equal({
					second: true,
					hello: "world"
				});
			});
		});
		describe("bottom_array", function() {
			var a = {
				steps: [{
					id: "client",
					label: "hello"
				}]
			};


			var b = {
				steps: [{
					id: "address",
					label: "heu"
				}, {
					id: "client",
					label: "world",
					testez: 1
				}]
			};
			compiler.bottom(b, a);
			it("should", function() {
				expect(JSON.stringify(a)).to.deep.equal(JSON.stringify({
					"steps": [{
						"id": "address",
						"label": "heu"
					}, {
						"id": "client",
						"label": "hello",
						"testez": 1
					}]
				}));
			});
		});
		describe("bottom_array2", function() {
			var a = [1, 2, 3, {
				id: "e1",
				title: "hello"
			}];

			var b = [4, 5, {
				id: "e1",
				title: "bottom title"
			}];
			compiler.bottom(b, a);
			it("should", function() {
				expect(JSON.stringify(a)).to.deep.equal(JSON.stringify([4, 5, {
					id: "e1",
					title: "hello"
				}, 1, 2, 3]));
			});
		});

		describe("aup1", function() {
			var a = {
				a: true
			};
			compiler.aup({
				b: true
			}, a);
			it("should", function() {
				expect(a).to.deep.equal({
					a: true,
					b: true
				});
			});
		});

		describe("abottom1", function() {
			var a = {
				a: true
			};
			compiler.abottom({
				b: true
			}, a);
			it("should", function() {
				expect(a).to.deep.equal({
					b: true,
					a: true
				});
			});
		});

		describe("up", function() {
			var tg = {
				a: true
			};
			compiler.up(tg, {
				b: true
			}, {
				c: true
			});
			it("should", function() {
				expect(tg).to.deep.equal({
					a: true,
					b: true,
					c: true
				});
			});
		});
		describe("bottom", function() {
			var tg = {
				a: true
			};
			compiler.bottom({
				b: true
			}, {
				c: true
			}, tg);
			it("should", function() {
				expect(tg).to.deep.equal({
					b: true,
					c: true,
					a: true
				});
			});
		});
	});



	describe("classes", function() {

		describe("classes datas independance", function() {
			var Mc = Classes(function(test) {
				this.schema.test = test;
			}, {
				schema: {
					bloup: true
				}
			});

			var a = new Mc("fromA");

			var b = new Mc("fromB");

			it("should", function() {
				expect(a.schema.bloup).equals(true);
				expect(a.schema.test).equals("fromA");
			});
		});
	});


	describe("colliders", function() {

		describe("insertAt", function() {

			var a = {
				b: [1, 2, 3]
			};
			var c = {
				b: collider.insertAt([4, 5], 2)
			};
			compiler.up(a, c);
			it("should", function() {
				expect(a).to.deep.equal({
					"b": [1, 2, 4, 5, 3]
				});
			});
		});
		describe("removeAt", function() {

			var a = {
				b: [1, 2, 3]
			};
			var c = {
				b: collider.removeAt(2, 1)
			};
			compiler.up(a, c);
			it("should", function() {
				expect(a).to.deep.equal({
					b: [1, 2]
				});
			});
		});
		describe("removeAt 2", function() {

			var a = {
				b: [1, 2, 3, 4, 5, 6]
			};
			var c = {
				b: collider.removeAt(2, 3)
			};
			compiler.up(a, c);
			it("should", function() {
				expect(a).to.deep.equal({
					b: [1, 2, 6]
				});
			});
		});
		describe("bottom", function() {

			var a = {
				test: collider.bottom({
					hello: "world"
				})
			};
			var b = {
				test: {
					myVar: true
				}
			};
			compiler.up(b, a);
			it("should", function() {
				expect(b).to.deep.equal({
					test: {
						hello: "world",
						myVar: true
					}
				});
			});
		});
		describe("bottom2", function() {

			var a = {
				test: collider.bottom({
					hello: "world"
				}, {
					bye: "bloup"
				})
			};
			var b = {
				test: {
					myVar: true
				}
			};
			compiler.up(b, a);
			it("should", function() {
				expect(b).to.deep.equal({
					test: {
						hello: "world",
						bye: "bloup",
						myVar: true
					}
				});
			});
		});
		describe("up", function() {
			var a = {
				test: collider.up({
					hello: "world"
				})
			};
			var b = {
				test: {
					myVar: true
				}
			};
			compiler.up(b, a)
			it("should", function() {
				expect(b).to.deep.equal({
					test: {
						myVar: true,
						hello: "world"
					}
				});
			});
		});
		describe("transform", function() {
			var a = {
				test: collider.transform(function(input) {
					return input + " world";
				})
			};
			var b = {
				test: "hello"
			};
			compiler.up(b, a)
			it("should", function() {
				expect(b).to.deep.equal({
					test: "hello world"
				});
			});
		});
	});


});