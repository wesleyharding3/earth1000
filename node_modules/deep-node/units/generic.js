if (typeof define !== 'function') {
    var define = require('amdefine')(module);
}

define(["require","deepjs/deep", "deepjs/lib/unit"], function (require, deep, Unit) {
    
    //_______________________________________________________________ GENERIC STORE TEST CASES
    var postTest = {
        id:"id123",
        title:"hello",
        order:2
    };
    var putTest = {
        id:"id123",
        order:2,
        otherVar:"yes"
    };
    var patchTest = {
        id:"id123",
        order:4,
        otherVar:"yes",
        newVar:true
    };

    var unit = {
        title:"deep-node-fs/json",
        stopOnError:true,
        setup:function(){
          /*  var fs = require('fs');
            fs.unlinkSync('/tmp/hello')
            console.log('successfully deleted /tmp/hello');*/
            return require("deep-node-fs/json").create("jsonfstest");
        },
        clean:deep.compose.after(function(){
            delete deep.protocols.jsonfstest;
        }),
        tests : {
            post:function(){
                return deep.restful(this)
                //.log("chain store init in test")
                .post( postTest )
                .equal( postTest )
                .get("id123")
                .equal(postTest);
            },
            put:function(){
                // post
                return deep.restful(this)
                // put
                .put(putTest)
                .equal( putTest )
                .get("id123")
                .equal( putTest );
            },
            patch:function(){
                // post
                return deep.restful(this)
                .patch({
                    order:4,
                    newVar:true,
                    id:"id123"
                })
                .equal(patchTest)
                //.log("patch")
                .get("id123")
                .equal(patchTest);
            },
            del:function () {
                var delDone = false;
                return deep.restful(this)
                .del("id123")
                .done(function (argument) {
                    delDone = true;
                })
                .get("id123")
                .fail(function(error){
                    if(delDone)
                        return true;
                });
            }
        }
    };



/*
deep.restful("myobjects")
.patch({
    id:"id1381690769563",
    test:"hello",
    fdfsdfsddsfsdfsfdfsd:"11111111111"
})
.rpc("first", ["hhhhh","gggggg"], "id1381690769563")
.get()
.bulk([
    {to:"id1381690769563", method:"patch", body:{name:"updated 2"}},
    {to:"id1381690769563", method:"get"},
    {to:"id1381690769563", method:"rpc", body:{ args:["hello","blkrpc"], method:"first" }}
])
.log();
*/
    return unit;
});
