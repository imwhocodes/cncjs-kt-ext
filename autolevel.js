/* eslint-disable no-useless-escape */
const SocketWrap = require('./socketwrap')

const alFileNamePrefix = '#AL:'

module.exports = class Autolevel {
  constructor(socket, options) {
    this.gcodeFileName = ''
    this.gcode = ''
    this.sckw = new SocketWrap(socket, options.port)
    this.delta = 10.0 // step
    this.feed = 50 // probing feedrate
    this.height = 2 // travelling height
    this.probedPoints = []
    this.planedPointCount = 0
    this.wco = {
      x: 0,
      y: 0,
      z: 0
    }
    this.decimals = 3
    socket.on('gcode:load', (file, gc) => {
      if (!file.startsWith(alFileNamePrefix)) {
        this.gcodeFileName = file
        this.gcode = gc
        console.log('gcode loaded:', file)
      }
    })

    socket.on('gcode:unload', () => {
      this.gcodeFileName = ''
      this.gcode = ''
      console.log('gcode unloaded')
    })

    socket.on('serialport:read', (data) => {
      if (data.indexOf('PRB') >= 0) {
        let prbm = /\[PRB:([\+\-\.\d]+),([\+\-\.\d]+),([\+\-\.\d]+),?([\+\-\.\d]+)?:(\d)\]/g.exec(data)
        if (prbm) {
          let prb = [parseFloat(prbm[1]), parseFloat(prbm[2]), parseFloat(prbm[3])]
          let pt = {
            x: prb[0] - this.wco.x,
            y: prb[1] - this.wco.y,
            z: prb[2] - this.wco.z
          }
          if (this.planedPointCount > 0) {
            this.probedPoints.push(pt)
            console.log('probed ' + this.probedPoints.length + '/' + this.planedPointCount + '>', pt.x.toFixed(this.decimals), pt.y.toFixed(this.decimals), pt.z.toFixed(this.decimals))
            if (this.probedPoints.length >= this.planedPointCount) {
              this.applyCompensation()
              this.planedPointCount = 0
            }
          }
        }
      }
    })

    //  this.socket.emit.apply(socket, ['write', this.port, "gcode", "G91 G1 Z1 F1000"]);
  }

  start(cmd, context) {
    console.log(cmd, context)

    if (!this.gcode) {
      this.sckw.sendGcode('(AL: no gcode loaded)')
      return
    }
    this.sckw.sendGcode('(AL: auto-leveling started)')
    let m = /D([\.\+\-\d]+)/gi.exec(cmd)
    if (m) this.delta = parseFloat(m[1])

    let h = /H([\.\+\-\d]+)/gi.exec(cmd)
    if (h) this.height = parseFloat(h[1])

    let f = /F([\.\+\-\d]+)/gi.exec(cmd)
    if (f) this.feed = parseFloat(f[1])

    let p = /P([\.\+\-\d]+)/gi.exec(cmd)
    if (p) this.decimals = parseFloat(p[1])

    console.log(`STEP: ${this.delta} mm HEIGHT:${this.height} mm FEED:${this.feed} DECIMALS:${this.decimals}`)

    this.wco = {
      x: context.mposx - context.posx,
      y: context.mposy - context.posy,
      z: context.mposz - context.posz
    }
    this.probedPoints = []
    this.planedPointCount = 0
    console.log('WCO:', this.wco)
    let code = []
    let dx = (context.xmax - context.xmin) / parseInt((context.xmax - context.xmin) / this.delta)
    let dy = (context.ymax - context.ymin) / parseInt((context.ymax - context.ymin) / this.delta)
    code.push('(AL: probing initial point)')
    code.push(`G90 G0 X${context.xmin.toFixed(this.decimals)} Y${context.ymin.toFixed(this.decimals)} Z${this.height}`)
    code.push(`G38.2 Z-${this.height} F${this.feed / 2}`)
    code.push(`G10 L20 P1 Z0`) // set the z zero
    code.push(`G0 Z${this.height}`)
    this.planedPointCount++

    let y = context.ymin - dy

    while (y < context.ymax - 0.01) {
      y += dy
      if (y > context.ymax) y = context.ymax
      let x = context.xmin - dx
      if (y <= context.ymin + 0.01) x = context.xmin // don't probe first point twice

      while (x < context.xmax - 0.01) {
        x += dx
        if (x > context.xmax) x = context.xmax
        code.push(`(AL: probing point ${this.planedPointCount + 1})`)
        code.push(`G90 G0 X${x.toFixed(this.decimals)} Y${y.toFixed(this.decimals)} Z${this.height}`)
        code.push(`G38.2 Z-${this.height} F${this.feed}`)
        code.push(`G0 Z${this.height}`)
        this.planedPointCount++
      }
    }
    this.sckw.sendGcode(code.join('\n'))
  }

  stripComments(line) {
    const re1 = new RegExp(/\s*\([^\)]*\)/g) // Remove anything inside the parentheses
    const re2 = new RegExp(/\s*;.*/g) // Remove anything after a semi-colon to the end of the line, including preceding spaces
    const re3 = new RegExp(/\s+/g)
    return (line.replace(re1, '').replace(re2, '').replace(re3, ''))
  };

  distanceSquared3(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y) + (p2.z - p1.z) * (p2.z - p1.z)
  }

  distanceSquared2(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y)
  }

  crossProduct3(u, v) {
    return {
      x: (u.y * v.z - u.z * v.y),
      y: -(u.x * v.z - u.z * v.x),
      z: (u.x * v.y - u.y * v.x)
    }
  }

  isColinear(u, v) {
    return Math.abs(u.x * v.y - u.y * v.x) < 0.00001
  }

  sub3(p1, p2) {
    return {
      x: p1.x - p2.x,
      y: p1.y - p2.y,
      z: p1.z - p2.z
    }
  }

  formatPt(pt) {
    return `(x:${pt.x.toFixed(this.decimals)} y:${pt.y.toFixed(this.decimals)} z:${pt.z.toFixed(this.decimals)})`
  }

  splitLineToSegments(p1, p2) {
    let res = []
    let v = this.sub3(p2, p1) // delta
    let dist = Math.sqrt(this.distanceSquared3(p1, p2)) // distance
    let dir = {
      x: v.x / dist,
      y: v.y / dist,
      z: v.z / dist
    } // direction vector
    let maxSegLength = this.delta / 2
    res.push({
      x: p1.x,
      y: p1.y,
      z: p1.z
    }) // first point
    for (let d = maxSegLength; d < dist; d += maxSegLength) {
      res.push({
        x: p1.x + dir.x * d,
        y: p1.y + dir.y * d,
        z: p1.z + dir.z * d
      }) // split points
    }
    res.push({
      x: p2.x,
      y: p2.y,
      z: p2.z
    }) // last point
    return res
  }


  isoscelesTrinagleSolver(side, base){
    let IsoscelesH = Math.sqrt(Math.pow(side, 2) - (Math.pow(base, 2) / 4))

    return Math.atan((2 * IsoscelesH) / base)

  }

  // splitCircleToArcs(p1, p2, pc) {
  //   let res = []

  //   let linearDist = Math.sqrt(this.distanceSquared2(p1, p2)) // distance

  //   let maxSegLength = this.delta / 2

  //   let radius = Math.sqrt(this.distanceSquared2(p1, pc))

  //   let angDist = this.isoscelesTrinagleSolver(radius, linearDist)

  //   let maxAngLength = this.isoscelesTrinagleSolver(radius, maxSegLength)

  //   let zVect = (p2.z - p1.z) / angDist

  //   res.push({
  //     x: p1.x,
  //     y: p1.y,
  //     z: p1.z
  //   }) // first point

  //   for (let a = maxAngLength; a < angDist; a += maxAngLength) {
  //     res.push({
  //       x: pc.x + (Math.cos(a) * radius),
  //       y: pc.y + (Math.sin(a) * radius),
  //       z: p1.z + (zVect * a)
  //     }) // split points
  //   }

  //   res.push({
  //     x: p2.x,
  //     y: p2.y,
  //     z: p2.z
  //   }) // last point

  //   return res
  // }

  splitCircleToArcs(p1, p2, pc) {
    let res = []

    res.push({
      x: p1.x,
      y: p1.y,
      z: p1.z
    }) // first point
    res.push({
      x: p2.x,
      y: p2.y,
      z: p2.z
    }) // last point
    return res
  }

  getThreeClosestPoints(pt) {
    let res = []
    if (this.probedPoints.length < 3) {
      return res
    }
    this.probedPoints.sort((a, b) => {
      return this.distanceSquared2(a, pt) < this.distanceSquared2(b, pt) ? -1 : 1
    })
    let i = 0
    while (res.length < 3 && i < this.probedPoints.length) {
      if (res.length === 2) {
        // make sure points are not colinear
        if (!this.isColinear(this.sub3(res[1], res[0]), this.sub3(this.probedPoints[i], res[0]))) {
          res.push(this.probedPoints[i])
        }
      } else {
        res.push(this.probedPoints[i])
      }
      i++
    }
    return res
  }

  compensateZCoord(pt) {
    let points = this.getThreeClosestPoints(pt)
    if (points.length < 3) {
      console.log('Cant find 3 closest points')
      return pt
    }
    let normal = this.crossProduct3(this.sub3(points[1], points[0]), this.sub3(points[2], points[0]))
    let pp = points[0] // point on plane
    let dz = 0 // compensation delta
    if (normal.z !== 0) {
      // find z at the point seg, on the plane defined by three points
      dz = pp.z - (normal.x * (pt.x - pp.x) + normal.y * (pt.y - pp.y)) / normal.z
    } else {
      console.log(this.formatPt(pt), 'normal.z is zero', this.formatPt(points[0]), this.formatPt(points[1]), this.formatPt(points[2]))
    }
    return {
      x: pt.x,
      y: pt.y,
      z: pt.z + dz
    }
  }

  clonePoint(p){
     
    let pc = {
            x: p.x,
            y: p.y,
            z: p.z
            }

    return pc

  }

  applyCompensation() {
    this.sckw.sendGcode(`(AL: applying compensation ...)`)
    console.log('apply leveling')
    try {

      let lines = this.gcode.split('\n')

      let p0 = {
        x: context.posx,
        y: context.posy,
        z: context.posz
      }

      let pt = this.clonePoint(p0)


      const GCodeModal = {
        LINEAR : {
                  RAPID:  0,
                  FEED: 1
        },
        ARC : {
                  CW:     2,
                  CCW:    3
              }
      }

      let gCodeMode = 0


      let abs = true
      let result = []

      lines.forEach(line => {

        let lineStripped = this.stripComments(line)

        if (/G91/gi.test(lineStripped)) abs = false
        if (/G90/gi.test(lineStripped)) abs = true

        if (/G0/gi.test(lineStripped)) gCodeMode = GCodeModal.LINEAR.RAPID

        if (/G1/gi.test(lineStripped)) gCodeMode = GCodeModal.LINEAR.FEED

        if (/G2/gi.test(lineStripped)) gCodeMode = GCodeModal.ARC.CW

        if (/G3/gi.test(lineStripped)) gCodeMode = GCodeModal.ARC.CCW

        let doNotTouchGCode = /(G38.+|G5.+|G10|G4.+|G92|G92.1)/gi.test(lineStripped)

        if( abs && (!doNotTouchGCode)){
          
          let xMatch = /X([\.\+\-\d]+)/gi.exec(lineStripped)
          if (xMatch) pt.x = parseFloat(xMatch[1])
  
          let yMatch = /Y([\.\+\-\d]+)/gi.exec(lineStripped)
          if (yMatch) pt.y = parseFloat(yMatch[1])
  
          let zMatch = /Z([\.\+\-\d]+)/gi.exec(lineStripped)
          if (zMatch) pt.z = parseFloat(zMatch[1])

          let anyXYZ = xMatch || yMatch || zMatch

          if (anyXYZ) {

            let lineStrippedCoordRemoved = lineStripped.replace(/([XYZ])([\.\+\-\d]+)/gi, '')
            let segs = []

            switch(gCodeMode){

              case seasons.LINEAR.RAPID:
              case seasons.LINEAR.FEED:
                segs = this.splitLineToSegments(p0, pt)
                break

              case seasons.ARC.CW:
              case seasons.ARC.CCW:

                let centerPoint = {
                  x: 0,
                  y: 0,
                  z: 0,
                }
  
                let iMatch = /I([\.\+\-\d]+)/gi.exec(lineStripped)
                if (iMatch) centerPoint.x = parseFloat(xMatch[1])
      
                let jMatch = /J([\.\+\-\d]+)/gi.exec(lineStripped)
                if (jMatch) centerPoint.y = parseFloat(yMatch[1])
    
                segs = this.splitCircleToArcs(p0, pt, centerPoint)
  
                // let pMatch = /P([\.\+\-\d]+)/gi.exec(lineStripped)
                // if (pMatch) circleConf.p = parseInt(zMatch[1])

                break
  
            }

            for (let seg of segs) {
              let cpt = this.compensateZCoord(seg)
              let newLine = lineStrippedCoordRemoved + ` X${cpt.x.toFixed(this.decimals)} Y${cpt.y.toFixed(this.decimals)} Z${cpt.z.toFixed(this.decimals)} (Z${seg.z.toFixed(this.decimals)})`
              result.push(newLine.trim())
            }
  
            p0 = this.clonePoint(pt)

          }

          else{
            result.push(lineStripped + ' (ORIGINAL)')
            console.log('WARNING: Non Touching GCODE ( ' + lineStripped + ' )' )
          }

          
        }

        else {
          result.push(lineStripped + ' (RELATIVE)')
          console.log('WARNING: Using Relative Mode or Skipped ( ' + lineStripped + ' )')
        }

      })


      const newgcodeFileName = alFileNamePrefix + this.gcodeFileName;
      this.sckw.sendGcode(`(AL: loading new gcode ${newgcodeFileName} ...)`)
      this.sckw.loadGcode(newgcodeFileName, result.join('\n'))
      this.sckw.sendGcode('(AL: finished)')
    } catch (x) {
      this.sckw.sendGcode(`(AL: error occurred ${x})`)
    }
    console.log('Leveling applied')
  }
}
